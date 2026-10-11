import { createHash } from 'crypto';

// ─── Structured sync failures ─────────────────────────────────────────────────
//
// Every failure a sync run sees — a whole flow throwing, or a single branch
// file failing inside a flow that otherwise carries on — is captured as a
// SyncFailure: which flow, which stage of it, the chain/store/file it was
// working on, and the original error with its stack. The sync endpoints return
// these in their JSON response and hand them to lib/githubIssues.ts, so a
// failure that the sync code deliberately swallows (to keep the other ~99
// branches going) is still reported instead of only reaching a log line.
//
// Deliberately dependency-free (no Mongo/Postgres import) so the GitHub
// Actions reporting script can load it without any database configured.

/** The step within a flow that failed. */
export type SyncStage =
  | 'login'
  | 'list-files'
  | 'head-check'
  | 'download'
  | 'decompress'
  | 'parse'
  | 'write-db'
  | 'sync-state'
  | 'request'
  | 'unknown';

export type FailureLevel = 'file' | 'flow';

export interface SyncFailure {
  /** stores | full | deltas (v2 full sync reports as "full-v2"). */
  flow: string;
  /** 'file' = one branch file failed and the flow carried on without it;
   *  'flow' = the flow as a whole failed for this chain. */
  level: FailureLevel;
  stage: SyncStage;
  chain?: string;
  storeId?: string;
  file?: string;
  message: string;
  stack?: string;
  cause?: string;
  /** ISO timestamp of when the failure was recorded. */
  occurredAt: string;
  /** Groups repeated occurrences of the same underlying problem — see
   *  failureFingerprint(). */
  fingerprint: string;
}

/** What the sync code knows at the point of failure; the endpoint fills in
 *  the flow, timestamp and fingerprint. */
export interface FailureInput {
  level: FailureLevel;
  error: unknown;
  chain?: string;
  storeId?: string;
  file?: string;
  /** Used when the error itself wasn't tagged with a stage. */
  stage?: SyncStage;
}

export type FailureSink = (failure: FailureInput) => void;

// ─── Stage tagging ────────────────────────────────────────────────────────────
//
// The stage rides on the original error object instead of wrapping it, so the
// message, stack and `instanceof` checks callers already rely on stay intact.
// The innermost tag wins: downloadFile tags a bad gzip body as 'decompress',
// and the surrounding 'download' wrapper leaves that alone.

const STAGE_KEY = 'syncStage';

export function tagStage<E>(err: E, stage: SyncStage): E | Error {
  const target: any = err instanceof Error ? err : new Error(String(err));
  if (!target[STAGE_KEY]) {
    Object.defineProperty(target, STAGE_KEY, { value: stage, enumerable: false, configurable: true });
  }
  return target;
}

export function stageOf(err: unknown): SyncStage | undefined {
  return (err as any)?.[STAGE_KEY];
}

/** Runs `fn`, tagging anything it throws with `stage` (unless already tagged). */
export async function withStage<T>(stage: SyncStage, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw tagStage(err, stage);
  }
}

// ─── Building failures ────────────────────────────────────────────────────────

const MAX_MESSAGE_CHARS = 4000;
const MAX_STACK_CHARS = 6000;

/** Strips control characters (e.g. a binary body preview quoted in an error)
 *  that would garble JSON logs and the issue body. Keeps newlines and tabs. */
export function sanitizeText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}… [truncated ${clean.length - max} chars]` : clean;
}

function describeCause(err: unknown): string | undefined {
  const cause = (err as any)?.cause;
  if (cause == null) return undefined;
  const code = cause?.code ? ` [${cause.code}]` : '';
  return sanitizeText(`${cause}${code}`, MAX_MESSAGE_CHARS);
}

/**
 * Normalises a message down to "the same underlying problem": file names,
 * numbers (timestamps, byte counts, store ids, request ids) and quoted body
 * previews vary between occurrences of one bug and must not split it into
 * separate issues.
 */
export function normalizeMessage(message: string): string {
  return message
    .split('; body starts:')[0]
    .replace(/[\w.-]+\.(gz|xml|zip)\b/gi, '<file>')
    // Vercel request ids ("sfo1::vj9vb-1791355822855-b17fd693eeb3") and other
    // long mixed letter/digit tokens differ on every request.
    .replace(/\b[a-z]{2,4}\d::[\w-]+/gi, '<request-id>')
    .replace(/\b(?=[a-z-]*\d)(?=[\d-]*[a-z])[a-z\d-]{12,}\b/gi, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/** Same flow + level + stage + chain + normalised message → same issue. The
 *  store and file are deliberately left out: one portal problem hitting 40
 *  branches is one issue listing 40 branches, not 40 issues. */
export function failureFingerprint(
  f: Pick<SyncFailure, 'flow' | 'level' | 'stage' | 'chain' | 'message'>,
): string {
  const key = [f.flow, f.level, f.stage, f.chain ?? '', normalizeMessage(f.message)].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function buildFailure(flow: string, input: FailureInput, now: Date = new Date()): SyncFailure {
  const err = input.error;
  const message = sanitizeText(err instanceof Error ? err.message || String(err) : String(err), MAX_MESSAGE_CHARS);
  const stage = stageOf(err) ?? input.stage ?? 'unknown';
  const base = {
    flow,
    level: input.level,
    stage,
    ...(input.chain ? { chain: input.chain } : {}),
    ...(input.storeId ? { storeId: input.storeId } : {}),
    ...(input.file ? { file: input.file } : {}),
    message,
    ...(err instanceof Error && err.stack ? { stack: sanitizeText(err.stack, MAX_STACK_CHARS) } : {}),
    ...(describeCause(err) ? { cause: describeCause(err) } : {}),
    occurredAt: now.toISOString(),
  };
  return { ...base, fingerprint: failureFingerprint(base) };
}

/** Collects failures for one endpoint invocation. */
export class FailureCollector {
  readonly failures: SyncFailure[] = [];

  constructor(private readonly flow: string) {}

  /** Bound so it can be handed straight to the sync functions as a sink. */
  readonly record: FailureSink = (input) => {
    this.failures.push(buildFailure(this.flow, input));
  };
}
