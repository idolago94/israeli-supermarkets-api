import { Cron } from 'croner';
import type { Engine } from './engine';
import { errorMessage } from './errors';
import type { Logger } from './logger';
import type { Repo, ScheduleRow } from './repo';

// ─── Scheduler ─────────────────────────────────────────────────────────────────
//
// Cron patterns are evaluated in the configured timezone (Asia/Jerusalem), so
// daylight-saving changes are handled by croner, not by hand-shifted UTC
// times. Instead of arming one timer per pattern, a tick every 30s asks
// "which schedules had an occurrence since they last fired?". That one rule
// covers the normal case and the machine waking from sleep: missed
// occurrences collapse into a single run, started once on wake.
//
// Only one run at a time. When a schedule falls due while a run is going, the
// new run is recorded as `skipped` (reason "overlap") instead of starting.
// When several fall due at once (after a long sleep), the highest-priority one
// runs (full > stores > deltas) and the others are recorded as skipped.

const TICK_MS = 30_000;
/** Don't look further back than this for missed occurrences. */
const MAX_CATCH_UP_MS = 3 * 24 * 60 * 60 * 1000;

export function validateCron(pattern: string, timezone: string): void {
  // Throws on an invalid pattern or timezone.
  new Cron(pattern, { timezone, paused: true }).nextRun();
}

/** The latest occurrence of `pattern` in (after, upTo], or undefined. */
export function latestOccurrence(pattern: string, timezone: string, after: number, upTo: number): number | undefined {
  const cron = new Cron(pattern, { timezone, paused: true });
  let cursor = new Date(Math.max(after, upTo - MAX_CATCH_UP_MS));
  let latest: number | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > upTo) break;
    latest = next.getTime();
    cursor = next;
  }
  return latest;
}

export function nextOccurrence(pattern: string, timezone: string, from: number): number | undefined {
  return new Cron(pattern, { timezone, paused: true }).nextRun(new Date(from))?.getTime();
}

export class Scheduler {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly engine: Engine,
    private readonly repo: Repo,
    private readonly timezone: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The next time each schedule will fire. */
  upcoming(): (ScheduleRow & { next_at: number | null })[] {
    const now = this.now();
    return this.repo.schedules().map((s) => ({
      ...s,
      next_at: s.paused ? null : nextOccurrence(s.cron, this.timezone, now) ?? null,
    }));
  }

  tick(): void {
    try {
      this.fireDue();
    } catch (err) {
      this.log.error('scheduler tick failed', { error: errorMessage(err) });
    }
  }

  private fireDue(): void {
    const now = this.now();
    const due: { schedule: ScheduleRow; at: number }[] = [];
    for (const s of this.repo.schedules()) {
      if (s.last_fired_at == null) {
        this.repo.updateSchedule(s.name, { last_fired_at: now }, now);
        continue;
      }
      if (s.paused) continue;
      let at: number | undefined;
      try {
        at = latestOccurrence(s.cron, this.timezone, s.last_fired_at, now);
      } catch (err) {
        this.log.error(`schedule "${s.name}" has an invalid pattern`, { cron: s.cron, error: errorMessage(err) });
        continue;
      }
      if (at !== undefined) due.push({ schedule: s, at });
    }
    if (!due.length) return;

    for (const d of due) this.repo.updateSchedule(d.schedule.name, { last_fired_at: d.at }, now);
    due.sort((a, b) => b.schedule.priority - a.schedule.priority || b.at - a.at);
    const [chosen, ...superseded] = due;

    for (const d of superseded) {
      this.engine.recordSkipped(
        { type: d.schedule.run_type, trigger: 'schedule', scheduleName: d.schedule.name, scheduledFor: d.at },
        `overlap: fell due together with "${chosen.schedule.name}", which ran instead`,
      );
    }

    const req = {
      type: chosen.schedule.run_type,
      trigger: 'schedule' as const,
      scheduleName: chosen.schedule.name,
      scheduledFor: chosen.at,
    };
    const late = now - chosen.at;
    const active = this.engine.activeRunId;
    if (active !== undefined) {
      this.engine.recordSkipped(req, `overlap: run #${active} was still in progress`);
      this.log.warn(`scheduled "${chosen.schedule.name}" skipped: run #${active} still in progress`);
      return;
    }
    const runId = this.engine.startRun({
      ...req,
      reason: late > 5 * 60_000 ? `started ${Math.round(late / 60_000)} min late (the machine was asleep or the service was down)` : null,
    });
    this.log.info(`scheduled "${chosen.schedule.name}" started run #${runId}`, { lateMs: late });
  }
}
