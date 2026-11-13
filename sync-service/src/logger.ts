import type { LogLevel, Repo } from './repo';

// ─── Structured logger ─────────────────────────────────────────────────────────
//
// Each line goes to the `logs` table, linked to the run / chain job / branch
// task / step it belongs to, and to stdout as one JSON object (captured by
// launchd/systemd). child() binds more context, so engine code just logs a
// message and the links come for free.

export interface LogContext {
  runId?: number;
  chainJobId?: number;
  taskId?: number;
  stepId?: number;
  chainId?: string;
  storeCode?: string;
  step?: string;
}

export type LogData = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Lowest level written to stdout (everything is written to the DB). */
  stdoutLevel?: LogLevel | 'silent';
  now?: () => number;
}

export class Logger {
  constructor(
    private readonly repo: Repo | null,
    readonly context: LogContext = {},
    private readonly opts: LoggerOptions = {},
  ) {}

  child(context: LogContext): Logger {
    return new Logger(this.repo, { ...this.context, ...context }, this.opts);
  }

  debug(msg: string, data?: LogData): void {
    this.write('debug', msg, data);
  }
  info(msg: string, data?: LogData): void {
    this.write('info', msg, data);
  }
  warn(msg: string, data?: LogData): void {
    this.write('warn', msg, data);
  }
  error(msg: string, data?: LogData): void {
    this.write('error', msg, data);
  }

  private write(level: LogLevel, msg: string, data?: LogData): void {
    const ts = (this.opts.now ?? Date.now)();
    const c = this.context;
    const extra: LogData = { ...(c.storeCode ? { storeCode: c.storeCode } : {}), ...(data ?? {}) };

    const stdoutLevel = this.opts.stdoutLevel ?? 'info';
    if (stdoutLevel !== 'silent' && LEVEL_ORDER[level] >= LEVEL_ORDER[stdoutLevel]) {
      const line = JSON.stringify({ ts: new Date(ts).toISOString(), level, msg, ...stripUndefined(c), ...extra });
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    }

    if (!this.repo) return;
    try {
      this.repo.insertLog({
        ts,
        level,
        msg,
        context: JSON.stringify(extra, errorReplacer),
        run_id: c.runId ?? null,
        chain_job_id: c.chainJobId ?? null,
        branch_task_id: c.taskId ?? null,
        step_id: c.stepId ?? null,
        chain_id: c.chainId ?? null,
        step_name: c.step ?? null,
      });
    } catch (err) {
      // Logging must never take a sync down (e.g. the disk is full).
      process.stderr.write(`[logger] failed to write log line: ${err}\n`);
    }
  }
}

function stripUndefined(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
