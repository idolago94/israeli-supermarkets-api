import { reportSyncFailuresSafely, IssueReporterConfig, issueReporterConfigFromEnv } from '../../lib/githubIssues';
import { SyncFailure, SyncStage, failureFingerprint, sanitizeText } from '../../lib/syncFailures';
import type { ServiceConfig } from './config';
import { errorMessage } from './errors';
import type { Logger } from './logger';
import type { Repo, RunRow } from './repo';

// ─── Failure notifications ─────────────────────────────────────────────────────
//
// A run that ends `partial` or `failed` opens or updates GitHub issues through
// the existing mechanism (lib/githubIssues.ts): one issue per distinct problem,
// deduplicated by fingerprint, with a link back to the run in the dashboard.
// Best-effort — a GitHub problem never changes a run's outcome.

export function buildRunFailures(repo: Repo, run: RunRow): SyncFailure[] {
  const flow = `local-${run.type}`;
  const failures: SyncFailure[] = [];
  const failedChains = new Set<string>();

  const push = (f: Omit<SyncFailure, 'fingerprint'>) => failures.push({ ...f, fingerprint: failureFingerprint(f) });

  for (const job of repo.chainJobsForRun(run.id)) {
    if (job.status !== 'failed' || !job.error) continue;
    failedChains.add(job.chain_id);
    push({
      flow,
      level: 'flow',
      stage: (job.error_stage as SyncStage) || 'unknown',
      chain: job.chain_id,
      message: sanitizeText(job.error, 4000),
      ...(job.stack ? { stack: sanitizeText(job.stack, 6000) } : {}),
      occurredAt: new Date(job.finished_at ?? run.created_at).toISOString(),
    });
  }
  for (const task of repo.tasksForRun(run.id)) {
    if (task.status !== 'failed') continue;
    const files: string[] = JSON.parse(task.files || '[]');
    push({
      flow,
      level: 'file',
      stage: (task.error_stage as SyncStage) || 'unknown',
      chain: task.chain_id,
      storeId: task.store_code,
      ...(files[0] ? { file: files[0] } : {}),
      message: sanitizeText(task.error ?? 'unknown error', 4000),
      ...(task.stack ? { stack: sanitizeText(task.stack, 6000) } : {}),
      occurredAt: new Date(task.finished_at ?? run.created_at).toISOString(),
    });
  }
  return failures;
}

export function makeNotifier(
  repo: Repo,
  config: ServiceConfig,
  log: Logger,
  reporter: IssueReporterConfig | null = issueReporterConfigFromEnv(),
): (run: RunRow) => Promise<void> {
  return async (run) => {
    if (run.status !== 'partial' && run.status !== 'failed') return;
    try {
      const failures = buildRunFailures(repo, run);
      if (!failures.length) return;
      const url = `${config.publicUrl}/#/runs/${run.id}`;
      const result = await reportSyncFailuresSafely(
        failures,
        {
          params: { type: run.type, trigger: run.trigger, ...JSON.parse(run.params || '{}') },
          executedAt: new Date(run.started_at ?? run.created_at).toISOString(),
          source: 'local sync service',
          logs: [{ label: 'Dashboard', value: url }],
          details: { Run: `#${run.id}`, Outcome: run.status },
        },
        reporter,
      );
      repo.updateRun(run.id, { notified: result.status === 'reported' || result.status === 'partial' ? 1 : 0 });
      log.info(`failure report: ${result.status}`, { runId: run.id, issues: result.issues.map((i) => i.url) });
    } catch (err) {
      log.error('failure notification crashed', { runId: run.id, error: errorMessage(err) });
    }
  };
}
