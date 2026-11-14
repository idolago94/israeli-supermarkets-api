import type { ServiceConfig } from './config';
import type { RawStore } from './rawStore';
import type { Repo } from './repo';

// ─── Retention, heartbeat and health ───────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Deletes runs (with their chains, branches, steps and logs) and log lines
 *  older than `retention.runDays`, and raw files older than
 *  `retention.rawDays`. */
export function cleanup(repo: Repo, raw: RawStore, config: ServiceConfig, now: number) {
  const runCutoff = now - config.retention.runDays * DAY;
  const rawCutoff = now - config.retention.rawDays * DAY;
  const db = repo.db;
  const runs = db.prepare(`delete from runs where created_at < ? and status <> 'running'`).run(runCutoff).changes;
  const logs = db.prepare('delete from logs where ts < ?').run(runCutoff).changes;
  const rawFolders = raw.deleteDaysBefore(rawCutoff);
  const rawRows = db
    .prepare('update raw_files set deleted_at = ? where created_at < ? and deleted_at is null')
    .run(now, rawCutoff).changes;
  return { runs, logs, rawFolders, rawRows };
}

export interface Heartbeat {
  pid: number;
  at: number;
  startedAt: number;
}

export function writeHeartbeat(repo: Repo, hb: Heartbeat): void {
  repo.setState('heartbeat', JSON.stringify(hb), hb.at);
}

export function readHeartbeat(repo: Repo): Heartbeat | undefined {
  const raw = repo.getState('heartbeat');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Heartbeat;
  } catch {
    return undefined;
  }
}

export interface HealthWarning {
  level: 'warn' | 'error';
  message: string;
}

/**
 * What the dashboard should warn about:
 *   - no deltas (or full) run has completed in `deltasMaxAgeHours`;
 *   - no full run has completed in `fullMaxAgeHours`;
 *   - the run in progress has been going over `longRunWarnMinutes`.
 * "Completed" means succeeded or partial — a partial run wrote most of its
 * branches, and its failures are reported separately.
 */
export function healthWarnings(repo: Repo, config: ServiceConfig, now: number): HealthWarning[] {
  const warnings: HealthWarning[] = [];
  const ok = ['succeeded', 'partial'] as const;

  const lastHourly = repo.lastRun(['deltas', 'full'], [...ok]);
  const hourlyAge = lastHourly?.finished_at ? now - lastHourly.finished_at : Infinity;
  if (hourlyAge > config.health.deltasMaxAgeHours * HOUR) {
    warnings.push({
      level: 'error',
      message: lastHourly
        ? `No hourly sync has completed in ${Math.round(hourlyAge / HOUR)} hours (last: run #${lastHourly.id}).`
        : 'No hourly sync has completed yet.',
    });
  }

  const lastFull = repo.lastRun(['full'], [...ok]);
  const fullAge = lastFull?.finished_at ? now - lastFull.finished_at : Infinity;
  if (fullAge > config.health.fullMaxAgeHours * HOUR) {
    warnings.push({
      level: 'error',
      message: lastFull
        ? `No full sync has completed in ${Math.round(fullAge / HOUR)} hours (last: run #${lastFull.id}).`
        : 'No full sync has completed yet.',
    });
  }

  const active = repo.activeRun();
  if (active?.started_at && now - active.started_at > config.longRunWarnMinutes * 60_000) {
    warnings.push({
      level: 'warn',
      message: `Run #${active.id} has been running for ${Math.round((now - active.started_at) / 60_000)} minutes (over ${config.longRunWarnMinutes}).`,
    });
  }
  return warnings;
}
