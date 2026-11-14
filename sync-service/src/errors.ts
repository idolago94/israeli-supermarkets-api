import { CerberusHttpError, CerberusSessionExpiredError } from '../../lib/cerberus';
import { stageOf } from '../../lib/syncFailures';

// ─── Error classification and retry policy ─────────────────────────────────────
//
//   transient  network trouble, 5xx/429, a step timeout, a dropped or
//              deadlocked DB connection — retried with exponential backoff
//              and jitter, up to SYNC_MAX_ATTEMPTS.
//   session    the portal session expired — log in again, retry the step.
//   permanent  a corrupt file, a parse or validation failure, a 4xx, a bug —
//              retrying can't help, so the branch fails right away.

export type ErrorKind = 'transient' | 'permanent' | 'session';

/** An error that retrying won't fix. */
export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** A file that parsed but looks wrong; it's kept out of the target DB. */
export class ValidationError extends PermanentError {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** A step ran past its timeout and was aborted. */
export class StepTimeoutError extends Error {
  constructor(readonly step: string, readonly timeoutMs: number) {
    super(`step "${step}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'StepTimeoutError';
  }
}

/** The run was cancelled from the dashboard. */
export class CancelledError extends Error {
  constructor(message = 'run cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  // postgres.js
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

/** Postgres SQLSTATEs worth retrying: connection exceptions (08xxx),
 *  serialization failure, deadlock, admin shutdown, too many connections. */
function isTransientSqlState(code: string): boolean {
  return /^08/.test(code) || ['40001', '40P01', '57P01', '57P02', '57P03', '53300'].includes(code);
}

function codesOf(err: unknown): string[] {
  const out: string[] = [];
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur.code === 'string') out.push(cur.code);
    if (typeof cur.errno === 'string') out.push(cur.errno);
    cur = cur.cause;
  }
  return out;
}

export function classifyError(err: unknown): ErrorKind {
  if (err instanceof CerberusSessionExpiredError) return 'session';
  if (err instanceof PermanentError) return 'permanent';
  if (err instanceof CancelledError) return 'permanent';
  if (err instanceof StepTimeoutError) return 'transient';
  if (err instanceof CerberusHttpError) {
    return err.status >= 500 || err.status === 429 || err.status === 408 ? 'transient' : 'permanent';
  }
  // A body that isn't the archive it claims to be, or XML that won't parse.
  const stage = stageOf(err);
  if (stage === 'decompress' || stage === 'parse') return 'permanent';

  for (const code of codesOf(err)) {
    if (TRANSIENT_CODES.has(code) || isTransientSqlState(code)) return 'transient';
  }
  const name = (err as any)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'transient';
  const message = String((err as any)?.message ?? err);
  // undici's network failures surface as TypeError("fetch failed") with the
  // real reason in `cause` — covered above when it carries a code.
  if (err instanceof TypeError && /fetch failed|terminated|other side closed/i.test(message)) return 'transient';
  if (/socket hang up|network|ECONNRESET|timed? ?out/i.test(message)) return 'transient';
  return 'permanent';
}

/** Exponential backoff with full jitter: random in [0, min(max, base·2^(n-1))],
 *  floored at half the step so retries never pile up instantly. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** The message, plus the underlying cause when there is one — undici reports
 *  every network failure as just "fetch failed" with the reason in `cause`. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const message = err.message || err.name;
  const cause: any = (err as any).cause;
  if (!cause) return message;
  const detail = [cause.code, cause.message ?? String(cause)].filter(Boolean).join(': ');
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

export function errorStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  const cause = (err as any).cause;
  return cause ? `${err.stack}\nCaused by: ${cause?.stack ?? cause}` : err.stack;
}
