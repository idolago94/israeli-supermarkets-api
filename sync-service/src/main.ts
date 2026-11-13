import { join } from 'path';
import { CHAINS } from '../../lib/chains';
import { SERVICE_ROOT, loadConfig, loadEnvFile } from './config';
import { openDb } from './db';
import { Engine } from './engine';
import { errorMessage } from './errors';
import { Logger } from './logger';
import { cleanup, readHeartbeat, writeHeartbeat } from './maintenance';
import { makeNotifier } from './notify';
import { cerberusPortal } from './portal';
import { RawStore } from './rawStore';
import { Repo } from './repo';
import { Scheduler } from './scheduler';
import { createDashboardServer } from './server';
import { postgresTarget } from './target';

// ─── Entry point ───────────────────────────────────────────────────────────────
//
//   npm start            (from sync-service/, after `npm ci` here and in the repo root)
//
// Starts the engine, the scheduler and the dashboard. Meant to be kept alive by
// launchd/systemd (see deploy/), which restart it on a crash; on start it
// requeues whatever a crash left running and resumes that run.

const HEARTBEAT_MS = 30_000;
const CLEANUP_MS = 6 * 60 * 60 * 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  loadEnvFile(join(SERVICE_ROOT, '.env'));
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const repo = new Repo(db);
  const log = new Logger(repo, {}, { stdoutLevel: (process.env.SYNC_LOG_LEVEL as any) || 'info' });

  // One service per data directory: two would both claim the same queue.
  const previous = readHeartbeat(repo);
  if (previous && previous.pid !== process.pid && Date.now() - previous.at < 2 * HEARTBEAT_MS && isAlive(previous.pid)) {
    log.error(`another sync service (pid ${previous.pid}) is already using ${config.dataDir} — exiting`);
    process.exit(1);
  }

  const databaseUrl = process.env.SYNC_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('SYNC_DATABASE_URL (or DATABASE_URL) is not set — point it at the catalog v2 Postgres database');
    process.exit(1);
  }

  const chains = config.chains.length ? CHAINS.filter((c) => config.chains.includes(c.id)) : CHAINS;
  const unknown = config.chains.filter((id) => !CHAINS.some((c) => c.id === id));
  if (unknown.length) log.warn(`SYNC_CHAINS lists unknown chains, ignored: ${unknown.join(', ')}`);

  const raw = new RawStore(config.rawDir);
  const target = postgresTarget(databaseUrl);
  const engine = new Engine({
    repo,
    config,
    portal: cerberusPortal,
    target,
    raw,
    log,
    chains,
    onRunFinished: makeNotifier(repo, config, log),
  });
  const scheduler = new Scheduler(engine, repo, config.timezone, log);
  const server = createDashboardServer({ engine, repo, scheduler, raw, config, log });

  const startedAt = Date.now();
  const beat = () => writeHeartbeat(repo, { pid: process.pid, at: Date.now(), startedAt });
  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);

  const runCleanup = () => {
    try {
      const r = cleanup(repo, raw, config, Date.now());
      if (r.runs || r.logs || r.rawFolders) log.info('retention cleanup', r);
    } catch (err) {
      log.error('retention cleanup failed', { error: errorMessage(err) });
    }
  };
  runCleanup();
  const cleaner = setInterval(runCleanup, CLEANUP_MS);

  engine.resumeInterrupted();
  scheduler.start();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  log.info(`sync service up — dashboard at ${config.publicUrl}`, {
    pid: process.pid,
    chains: chains.map((c) => c.id),
    dataDir: config.dataDir,
    timezone: config.timezone,
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — shutting down; an unfinished run resumes on the next start`);
    scheduler.stop();
    clearInterval(heartbeat);
    clearInterval(cleaner);
    server.close();
    server.closeAllConnections?.();
    // Branch writes are single transactions: one cut short is rolled back by
    // Postgres, and its task is requeued on the next start.
    target
      .close()
      .catch(() => {})
      .finally(() => {
        db.close();
        process.exit(0);
      });
    setTimeout(() => process.exit(0), 8_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: errorMessage(reason) });
  });
}

main().catch((err) => {
  process.stderr.write(`sync service failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
