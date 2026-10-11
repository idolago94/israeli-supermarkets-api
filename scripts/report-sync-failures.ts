// Files GitHub issues for a catalog-sync workflow job's failures — the
// scheduler-side half of failure reporting (the sync endpoint is the other
// half, see lib/syncEndpoint.ts).
//
// The workflow asks the endpoint not to file issues itself
// (`x-sync-issue-reporting: caller`) and runs this after its request loop,
// because only the workflow sees all of:
//   • failures the endpoint returned in `failures` (incl. branch files it
//     skipped while the chain otherwise synced fine),
//   • invocations that never produced a response from our code at all — a
//     crashed or timed-out function (FUNCTION_INVOCATION_FAILED, curl
//     timeout), a 4xx from a bad SYNC_SECRET/CATALOG_API_BASE,
//   • every retry attempt of the same request, which it groups into one
//     report instead of one per attempt,
//   • the Actions run URL to link the logs from.
//
// Usage (from .github/workflows/catalog-sync.yml):
//   npx ts-node scripts/report-sync-failures.ts <attempts-dir>
// where <attempts-dir> holds attempt-<n>.json (response body) and
// attempt-<n>.meta (key=value lines: curl_rc, http_status, vercel_id,
// started_at) per attempt. Run context comes from the standard GITHUB_*
// variables plus MODE, CHAIN, FORCE and SCHEDULE. Always exits 0: reporting
// must never change the job's outcome — problems go to the log as warnings.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SyncFailure, buildFailure, failureFingerprint, sanitizeText } from '../lib/syncFailures';
import { ReportContext, reportSyncFailuresSafely, issueReporterConfigFromEnv } from '../lib/githubIssues';

export interface Attempt {
  n: number;
  curlRc: number;
  httpStatus: number;
  vercelId?: string;
  startedAt: string;
  body: string;
}

export function readAttempts(dir: string): Attempt[] {
  return readdirSync(dir)
    .map((f) => /^attempt-(\d+)\.meta$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const n = Number(m[1]);
      const meta = Object.fromEntries(
        readFileSync(join(dir, m[0]), 'utf8')
          .split('\n')
          .map((l) => l.split(/=(.*)/s).slice(0, 2))
          .filter((kv) => kv[0]),
      );
      let body = '';
      try {
        body = readFileSync(join(dir, `attempt-${n}.json`), 'utf8');
      } catch {
        // no body written (curl failed before receiving one)
      }
      return {
        n,
        curlRc: Number(meta.curl_rc ?? 0),
        httpStatus: Number(meta.http_status ?? 0),
        vercelId: meta.vercel_id || undefined,
        startedAt: meta.started_at || new Date().toISOString(),
        body,
      };
    })
    .sort((a, b) => a.n - b.n);
}

function isSyncFailure(x: any): x is SyncFailure {
  return (
    x &&
    typeof x.flow === 'string' &&
    typeof x.stage === 'string' &&
    typeof x.message === 'string' &&
    (x.level === 'file' || x.level === 'flow')
  );
}

const CURL_ERRORS: Record<number, string> = {
  6: 'could not resolve host',
  7: 'could not connect',
  28: 'timed out',
  35: 'TLS handshake failed',
  52: 'empty reply from server',
  56: 'connection reset while receiving',
};

/**
 * Builds the failures to report from a job's request attempts: whatever the
 * endpoint returned in `failures` (unless it already filed them), plus one
 * synthesised flow-level failure for each failed attempt whose response
 * didn't carry one — the cases the endpoint can't report itself.
 */
export function collectFailures(attempts: Attempt[], flow: string, chain: string | undefined): SyncFailure[] {
  const out: SyncFailure[] = [];
  for (const a of attempts) {
    let json: any;
    try {
      json = JSON.parse(a.body);
    } catch {
      json = undefined;
    }
    const returned: any[] = Array.isArray(json?.failures) ? json.failures : [];
    const alreadyReported = json?.issueReport?.status === 'reported';
    if (!alreadyReported) {
      for (const f of returned.filter(isSyncFailure)) {
        // Recomputed rather than trusted, so both halves always agree.
        out.push({ ...f, fingerprint: failureFingerprint(f) });
      }
    }

    const ok = a.curlRc === 0 && a.httpStatus >= 200 && a.httpStatus < 300;
    if (ok || returned.some((f) => f?.level === 'flow')) continue;

    let message: string;
    if (a.curlRc !== 0) {
      message = `request to the ${flow} sync endpoint failed: curl exit ${a.curlRc}${
        CURL_ERRORS[a.curlRc] ? ` (${CURL_ERRORS[a.curlRc]})` : ''
      }`;
    } else {
      const detail = typeof json?.error === 'string' ? json.error : a.body.replace(/\s+/g, ' ').trim();
      message = `HTTP ${a.httpStatus} from the ${flow} sync endpoint: ${sanitizeText(detail || '(empty body)', 1000)}`;
    }
    const err = new Error(message);
    err.stack = undefined; // the stack would be this script's, not the sync's
    out.push(buildFailure(flow, { level: 'flow', stage: 'request', error: err, chain }, new Date(a.startedAt)));
  }
  return out;
}

export function workflowContext(attempts: Attempt[], env: NodeJS.ProcessEnv): ReportContext {
  const last = attempts[attempts.length - 1];
  const lastOk = !!last && last.curlRc === 0 && last.httpStatus >= 200 && last.httpStatus < 300;
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` +
        (env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : '')
      : '';

  const logs: { label: string; value: string }[] = [];
  if (runUrl) logs.push({ label: `GitHub Actions run (job "${env.JOB_NAME || 'sync'}")`, value: runUrl });
  for (const a of attempts) {
    if (a.vercelId) logs.push({ label: `Vercel request id, attempt ${a.n}`, value: a.vercelId });
  }

  return {
    params: {
      flow: env.MODE,
      chain: env.CHAIN,
      force: env.FORCE === 'true',
      trigger: env.GITHUB_EVENT_NAME,
      ...(env.SCHEDULE ? { schedule: env.SCHEDULE } : {}),
      ...(env.ENDPOINT ? { endpoint: env.ENDPOINT } : {}),
    },
    executedAt: attempts[0]?.startedAt ?? new Date().toISOString(),
    source: 'catalog-sync workflow (GitHub Actions)',
    logs,
    details: {
      'Request attempts': attempts
        .map((a) => `#${a.n}: ${a.curlRc ? `curl exit ${a.curlRc}` : `HTTP ${a.httpStatus}`}`)
        .join(', '),
      'Job outcome': lastOk
        ? attempts.length > 1
          ? `succeeded on attempt ${last.n}`
          : 'succeeded'
        : `failed after ${attempts.length} attempt(s)`,
      ...(env.GITHUB_SHA ? { Commit: env.GITHUB_SHA.slice(0, 12) } : {}),
    },
  };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.log('::warning::report-sync-failures: no attempts directory given');
    return;
  }
  const attempts = readAttempts(dir);
  const failures = collectFailures(attempts, process.env.MODE || 'unknown', process.env.CHAIN || undefined);
  if (!failures.length) {
    console.log('No sync failures to report.');
    return;
  }

  console.log(`Reporting ${failures.length} sync failure(s)…`);
  const result = await reportSyncFailuresSafely(failures, workflowContext(attempts, process.env), issueReporterConfigFromEnv());
  for (const i of result.issues) console.log(`${i.action === 'created' ? 'Opened' : 'Commented on'} ${i.url}`);
  if (result.status !== 'reported') {
    console.log(`::warning::Sync failure reporting ${result.status}: ${result.errors.join('; ') || 'not configured'}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    // Never fail the job over reporting — the sync step already set its outcome.
    console.log(`::warning::Sync failure reporting crashed: ${err}`);
  });
}
