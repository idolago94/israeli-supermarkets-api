import { accessSync, constants, existsSync, mkdirSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import { SERVICE_ROOT, loadConfig, loadEnvFile } from './config';
import { errorMessage } from './errors';

// ─── npm run doctor ────────────────────────────────────────────────────────────
//
// Checks everything the service needs, in the order SETUP.md sets it up, and
// prints the fix for each problem. Exits 1 if a required check fails.
// Read-only: it changes nothing except creating the data directory.

type Result = { ok: boolean; required: boolean; label: string; detail?: string; fix?: string };
const results: Result[] = [];

function record(r: Result): void {
  results.push(r);
  const mark = r.ok ? '✓' : r.required ? '✗' : '!';
  console.log(`${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.ok && r.fix) console.log(`    fix: ${r.fix}`);
}

async function check(label: string, required: boolean, fn: () => Promise<string | void> | string | void, fix: string) {
  try {
    const detail = await fn();
    record({ ok: true, required, label, detail: detail || undefined });
  } catch (err) {
    record({ ok: false, required, label, detail: errorMessage(err), fix });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);
}

async function main(): Promise<void> {
  const envPath = join(SERVICE_ROOT, '.env');

  await check('Node.js 20 or newer', true, () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`found ${process.version}`);
    return process.version;
  }, 'install Node 20+ (e.g. `nvm install 20`), then re-run `npm ci` in the repo root and in sync-service/');

  await check('repo-root dependencies installed (lib/ needs them)', true, () => {
    require.resolve('postgres', { paths: [join(SERVICE_ROOT, '..', 'lib')] });
    require.resolve('undici', { paths: [join(SERVICE_ROOT, '..', 'lib')] });
  }, 'run `npm ci` in the repo root (not only in sync-service/)');

  await check('SQLite driver (better-sqlite3) loads', true, () => {
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
  }, 'run `npm ci` in sync-service/. After changing Node versions: `npm rebuild better-sqlite3`');

  await check('sync-service/.env exists', true, () => {
    if (!existsSync(envPath)) throw new Error('missing');
  }, 'run `cp .env.example .env` in sync-service/ and set SYNC_DATABASE_URL');
  loadEnvFile(envPath);

  let config: ReturnType<typeof loadConfig> | undefined;
  await check('configuration is valid', true, () => {
    config = loadConfig();
    return `port ${config.port}, data in ${config.dataDir}, timezone ${config.timezone}`;
  }, 'correct the value named in the error in sync-service/.env');

  const url = process.env.SYNC_DATABASE_URL || process.env.DATABASE_URL;
  await check('SYNC_DATABASE_URL is set', true, () => {
    if (!url) throw new Error('not set');
    return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
  }, 'set SYNC_DATABASE_URL in sync-service/.env to the catalog v2 Postgres connection string');

  if (url) {
    const postgres = require('postgres');
    const sql = postgres(url, { max: 1, connect_timeout: 15, onnotice: () => {}, prepare: process.env.SYNC_PG_PREPARE !== 'false' });
    let connected = false;
    await check('target database reachable', true, async () => {
      const [r] = await withTimeout<any[]>(sql`select version() as v`, 20_000, 'connecting');
      connected = true;
      return String(r.v).split(' ').slice(0, 2).join(' ');
    }, 'check the connection string, network and password. For Supabase\'s transaction pooler (port 6543) set SYNC_PG_PREPARE=false');

    if (connected) {
      await check('catalog v2 tables and the delta-cursor columns exist', true, async () => {
        const tables = await sql`select table_name from information_schema.tables where table_schema = current_schema()
          and table_name in ('chains', 'stores', 'products', 'prices')`;
        const missingTables = ['chains', 'stores', 'products', 'prices'].filter((t) => !tables.some((r: any) => r.table_name === t));
        if (missingTables.length) throw new Error(`missing tables: ${missingTables.join(', ')}`);
        const cols = await sql`select column_name from information_schema.columns where table_schema = current_schema()
          and table_name = 'stores' and column_name in ('last_delta_ts', 'last_delta_file')`;
        if (cols.length < 2) throw new Error('stores.last_delta_ts / last_delta_file missing');
      }, 'run `npm run migrate` in sync-service/');
    }
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  if (config) {
    const c = config;
    await check('data directory is writable', true, () => {
      mkdirSync(c.dataDir, { recursive: true });
      accessSync(c.dataDir, constants.W_OK);
      return c.dataDir;
    }, 'point SYNC_DATA_DIR at a folder you can write to');

    let running = false;
    await check('service status', false, async () => {
      try {
        const res = await withTimeout(fetch(`http://127.0.0.1:${c.port}/api/health`), 3000, 'health check');
        const body: any = await res.json();
        running = true;
        const warnings = (body.warnings ?? []).map((w: any) => w.message).join(' ');
        return `running (pid ${body.heartbeat?.pid}) at ${c.publicUrl}${warnings ? `. Warnings: ${warnings}` : ''}`;
      } catch {
        // Not running: make sure it could start.
        await new Promise<void>((resolve, reject) => {
          const s = createServer();
          s.once('error', () => reject(new Error(`not running, and port ${c.port} is taken by another program`)));
          s.listen(c.port, c.host, () => s.close(() => resolve()));
        });
        return `not running; port ${c.port} is free. Start it with \`npm start\` or install it (SETUP.md, step 5)`;
      }
    }, 'free the port or set SYNC_PORT in sync-service/.env');
    void running;
  }

  await check('Cerberus portal reachable (logs in to one chain)', false, async () => {
    const { cerberusLogin } = require('../../lib/cerberus');
    const { CHAINS } = require('../../lib/chains');
    const cookie = await withTimeout<string>(cerberusLogin(CHAINS[0].username), 60_000, 'login');
    if (!cookie) throw new Error('login returned no session cookie');
    return `logged in as ${CHAINS[0].username}`;
  }, 'check internet access to url.publishedprices.co.il. A corporate/VPN TLS proxy breaks the portal\'s certificate check');

  await check('GitHub failure reports configured', false, () => {
    if (!(process.env.SYNC_ISSUES_GITHUB_TOKEN && process.env.SYNC_ISSUES_GITHUB_REPO)) throw new Error('not configured (optional)');
    return process.env.SYNC_ISSUES_GITHUB_REPO;
  }, 'optional: set SYNC_ISSUES_GITHUB_TOKEN and SYNC_ISSUES_GITHUB_REPO in sync-service/.env');

  const failed = results.filter((r) => !r.ok && r.required);
  console.log(failed.length ? `\n${failed.length} required check(s) failed.` : '\nAll required checks passed.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`doctor crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
