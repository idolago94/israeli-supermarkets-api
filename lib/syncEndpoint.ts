import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSyncSecret } from './auth';
import { ChainConfig } from './cerberus';
import { FailureCollector, FailureSink } from './syncFailures';
import { IssueReportResult, ReportContext, reportSyncFailuresSafely } from './githubIssues';

// ─── Shared /api/sync/* handler ───────────────────────────────────────────────
//
// The sync endpoints differ only in which flow they run; this owns everything
// else they share: the SYNC_SECRET check, ?chain=<id> vs all chains, the
// response shape, and failure reporting. Every failure — a chain's flow
// throwing, or a branch file the flow skipped past — is recorded, returned in
// the response's `failures`, and filed as a GitHub issue (lib/githubIssues.ts)
// before responding (the platform may freeze the function once it responds).
//
// Reporting is best-effort and isolated: it runs after the sync's outcome is
// decided, never throws, and can't change the status code or error message.
//
// A caller that files issues itself sends `x-sync-issue-reporting: caller` —
// the GitHub Actions scheduler does, because it also sees failures this
// function can't (a crashed or timed-out invocation never reaches this code)
// and can group a retried request's attempts into one report.

export interface SyncEndpointSpec {
  /** stores | full | deltas | full-v2 — becomes the issue's "Flow". */
  flow: string;
  chains: ChainConfig[];
  findChain: (id: string) => ChainConfig | undefined;
  /** Flow-specific query parameters, echoed into the report (e.g. force). */
  params?: Record<string, unknown>;
  run: (chain: ChainConfig, onFailure: FailureSink) => Promise<unknown>;
  /** Test seam; defaults to reportSyncFailuresSafely with env config. */
  report?: (failures: FailureCollector['failures'], ctx: ReportContext) => Promise<IssueReportResult>;
}

function describeError(err: unknown): string {
  const cause = (err as any)?.cause;
  return `${err}${cause ? ` (cause: ${cause})` : ''}`;
}

function header(req: VercelRequest, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function reportContext(req: VercelRequest, flow: string, params: Record<string, unknown>, startedAt: Date): ReportContext {
  const logs: { label: string; value: string }[] = [];
  const requestId = header(req, 'x-vercel-id');
  if (requestId) logs.push({ label: 'Vercel request id (search it in the project’s Logs tab)', value: requestId });
  if (process.env.VERCEL_URL) logs.push({ label: 'Deployment', value: `https://${process.env.VERCEL_URL}` });
  // Optional link back to whatever triggered this run; only GitHub URLs are
  // accepted so a caller can't plant arbitrary links in the issue.
  const runUrl = header(req, 'x-sync-run-url');
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(runUrl)) {
    logs.push({ label: 'Triggering GitHub Actions run', value: runUrl });
  }
  return {
    params: { flow, ...params },
    executedAt: startedAt.toISOString(),
    source: 'sync endpoint (Vercel function)',
    logs,
    details: {
      Endpoint: `${req.method ?? 'POST'} ${(req.url ?? '').split('?')[0]}`,
      ...(process.env.VERCEL_ENV ? { Environment: process.env.VERCEL_ENV } : {}),
    },
  };
}

export async function runSyncEndpoint(req: VercelRequest, res: VercelResponse, spec: SyncEndpointSpec): Promise<void> {
  if (!requireSyncSecret(req, res)) return;

  const startedAt = new Date();
  const chainId = (req.query.chain as string) || '';
  const params = { chain: chainId || 'all', ...(spec.params ?? {}) };
  const collector = new FailureCollector(spec.flow);

  let status = 200;
  let payload: Record<string, unknown>;

  if (chainId) {
    const chain = spec.findChain(chainId);
    if (!chain) {
      // A bad request, not a sync failure — nothing ran.
      res.status(400).json({ error: `unknown chain: ${chainId}` });
      return;
    }
    try {
      payload = { ok: true, result: await spec.run(chain, collector.record) };
    } catch (err) {
      collector.record({ level: 'flow', error: err, chain: chain.id });
      status = 500;
      payload = { error: describeError(err) };
    }
  } else {
    const summary: Record<string, unknown> = {};
    for (const chain of spec.chains) {
      try {
        summary[chain.id] = await spec.run(chain, collector.record);
      } catch (err) {
        collector.record({ level: 'flow', error: err, chain: chain.id });
        summary[chain.id] = `error: ${describeError(err)}`;
      }
    }
    payload = { ok: true, summary };
  }

  if (collector.failures.length) {
    let issueReport: IssueReportResult;
    if (header(req, 'x-sync-issue-reporting').toLowerCase() === 'caller') {
      issueReport = { status: 'delegated', issues: [], errors: [] };
    } else {
      const ctx = reportContext(req, spec.flow, params, startedAt);
      try {
        issueReport = await (spec.report ?? reportSyncFailuresSafely)(collector.failures, ctx);
      } catch (err) {
        // reportSyncFailuresSafely doesn't throw; this guards a custom `report`.
        console.error(`[sync-issues] issue reporting failed: ${err}`);
        issueReport = { status: 'failed', issues: [], errors: [String(err)] };
      }
    }
    payload = { ...payload, failures: collector.failures, issueReport };
  }

  res.status(status).json(payload);
}
