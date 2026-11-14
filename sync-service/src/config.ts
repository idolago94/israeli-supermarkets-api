import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────────
//
// Everything comes from the environment, optionally loaded from
// sync-service/.env (see .env.example for every key and its default).
// loadConfig() takes the env as a parameter so tests can build a config
// without touching process.env.

export const SERVICE_ROOT = resolve(__dirname, '..');

/** Steps with their own timeout. Chain-level and branch-level together. */
export const STEP_NAMES = [
  'login',
  'stores-file',
  'list-files',
  'head-check',
  'download',
  'decompress',
  'parse',
  'validate',
  'write-db',
  'finalize',
  'recompute-names',
] as const;
export type StepName = (typeof STEP_NAMES)[number];

export interface ServiceConfig {
  dataDir: string;
  dbPath: string;
  rawDir: string;
  host: string;
  port: number;
  /** Base URL used in links (GitHub issues) to dashboard pages. */
  publicUrl: string;
  timezone: string;
  /** Chain ids to sync; empty = every chain in lib/chains.ts. */
  chains: string[];
  /** Branches processed at once inside one chain. */
  branchConcurrency: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Times a task may log in again after its session expired. */
  maxRelogins: number;
  breaker: {
    /** Failure ratio (0..1) among finished branches that stops the chain. */
    threshold: number;
    /** Finished branches needed before the ratio is trusted. */
    minSamples: number;
  };
  timeoutsMs: Record<StepName, number>;
  validation: {
    /** A PriceFull file with fewer items is treated as broken. */
    minItemsFull: number;
    /** Fail when the item count dropped by more than this ratio (0..1)
     *  versus the branch's previous successful full file. */
    maxItemDropRatio: number;
    /** A price above this (₪) is suspicious. */
    maxPrice: number;
    /** Fail when more than this ratio of items has a suspicious price. */
    maxBadPriceRatio: number;
  };
  retention: { runDays: number; rawDays: number };
  /** Dashboard warns when a run has been going this long. */
  longRunWarnMinutes: number;
  health: { deltasMaxAgeHours: number; fullMaxAgeHours: number };
  maxItemsPerFile: number;
}

/** Minimal .env reader: KEY=VALUE lines, # comments, optional quotes. Values
 *  already in the environment win, so a real env var overrides the file. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return n;
}

const DEFAULT_TIMEOUTS_MS: Record<StepName, number> = {
  login: 60_000,
  'stores-file': 180_000,
  'list-files': 120_000,
  'head-check': 30_000,
  download: 300_000,
  decompress: 60_000,
  parse: 120_000,
  validate: 30_000,
  'write-db': 300_000,
  finalize: 60_000,
  'recompute-names': 900_000,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const dataDirRaw = env.SYNC_DATA_DIR || 'data';
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : join(SERVICE_ROOT, dataDirRaw);
  const host = env.SYNC_HOST || '127.0.0.1';
  const port = num(env, 'SYNC_PORT', 4100);

  const timeoutsMs = { ...DEFAULT_TIMEOUTS_MS };
  for (const step of STEP_NAMES) {
    const key = `SYNC_TIMEOUT_${step.toUpperCase().replace(/-/g, '_')}_MS`;
    timeoutsMs[step] = num(env, key, timeoutsMs[step]);
  }

  return {
    dataDir,
    dbPath: join(dataDir, 'sync.db'),
    rawDir: join(dataDir, 'raw'),
    host,
    port,
    publicUrl: (env.SYNC_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    timezone: env.SYNC_TIMEZONE || 'Asia/Jerusalem',
    chains: (env.SYNC_CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    branchConcurrency: Math.max(1, num(env, 'SYNC_BRANCH_CONCURRENCY', 3)),
    maxAttempts: Math.max(1, num(env, 'SYNC_MAX_ATTEMPTS', 3)),
    backoffBaseMs: num(env, 'SYNC_BACKOFF_BASE_MS', 2_000),
    backoffMaxMs: num(env, 'SYNC_BACKOFF_MAX_MS', 60_000),
    maxRelogins: num(env, 'SYNC_MAX_RELOGINS', 2),
    breaker: {
      threshold: num(env, 'SYNC_BREAKER_THRESHOLD', 0.5),
      minSamples: num(env, 'SYNC_BREAKER_MIN_SAMPLES', 6),
    },
    timeoutsMs,
    validation: {
      minItemsFull: num(env, 'SYNC_MIN_ITEMS_FULL', 100),
      maxItemDropRatio: num(env, 'SYNC_MAX_ITEM_DROP_RATIO', 0.5),
      maxPrice: num(env, 'SYNC_MAX_PRICE', 10_000),
      maxBadPriceRatio: num(env, 'SYNC_MAX_BAD_PRICE_RATIO', 0.01),
    },
    retention: {
      runDays: num(env, 'SYNC_RETENTION_DAYS', 90),
      rawDays: num(env, 'SYNC_RAW_RETENTION_DAYS', 14),
    },
    longRunWarnMinutes: num(env, 'SYNC_LONG_RUN_WARN_MINUTES', 45),
    health: {
      deltasMaxAgeHours: num(env, 'SYNC_HEALTH_DELTAS_MAX_AGE_HOURS', 2),
      fullMaxAgeHours: num(env, 'SYNC_HEALTH_FULL_MAX_AGE_HOURS', 26),
    },
    maxItemsPerFile: num(env, 'SYNC_MAX_ITEMS_PER_FILE', 50_000),
  };
}
