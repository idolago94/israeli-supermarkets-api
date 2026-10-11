import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_LABEL,
  ReportContext,
  issueReporterConfigFromEnv,
  markerFor,
  renderIssueBody,
  renderIssueTitle,
  reportSyncFailures,
  reportSyncFailuresSafely,
} from '../lib/githubIssues';
import { SyncFailure, buildFailure, tagStage } from '../lib/syncFailures';
import { FakeGitHub } from './helpers';

const ctx: ReportContext = {
  params: { flow: 'deltas', chain: 'rami_levy' },
  executedAt: '2026-10-11T11:17:44.000Z',
  source: 'test',
  logs: [
    { label: 'GitHub Actions run', value: 'https://github.com/o/r/actions/runs/1' },
    { label: 'Vercel request id', value: 'sfo1::abc' },
  ],
};

function gzipFailure(store: string): SyncFailure {
  return buildFailure('deltas', {
    level: 'file',
    error: tagStage(new Error(`invalid gzip for price7290058140886-${store}-202607151000.gz (14207 bytes): incorrect header check`), 'decompress'),
    chain: 'rami_levy',
    storeId: store,
    file: `price7290058140886-${store}-202607151000.gz`,
  });
}

function config(gh: FakeGitHub) {
  return { token: 't', repo: 'o/r', fetchImpl: gh.fetch };
}

test('creates one labelled issue per distinct problem, grouping its occurrences', async () => {
  const gh = new FakeGitHub();
  const loginFailure = buildFailure('deltas', { level: 'flow', error: tagStage(new Error('fetch failed'), 'login'), chain: 'rami_levy' });
  const result = await reportSyncFailures([gzipFailure('039'), gzipFailure('040'), loginFailure], ctx, config(gh));

  assert.equal(result.status, 'reported');
  assert.equal(gh.issues.length, 2);
  assert.deepEqual(gh.issues.map((i) => i.labels), [[ISSUE_LABEL], [ISSUE_LABEL]]);
  const gzipIssue = gh.issues[0];
  assert.match(gzipIssue.title, /^Sync failure: deltas \/ rami_levy — decompress: invalid gzip/);
  assert.ok(gzipIssue.body.includes(markerFor(gzipFailure('039').fingerprint)));
  assert.match(gzipIssue.body, /Failures in this run \| 2/);
  assert.match(gzipIssue.body, /store `039`/);
  assert.match(gzipIssue.body, /store `040`/);
});

test('issue body carries every required section', () => {
  const body = renderIssueBody([gzipFailure('039')], ctx);
  for (const expected of [
    /\| Flow \| `deltas` \|/,
    /\| Failed stage \| `decompress` \|/,
    /\| Chain \| `rami_levy` \|/,
    /\| Store IDs \| `039` \|/,
    /\| Execution started \| `2026-10-11T11:17:44.000Z` \|/,
    /\*\*Execution parameters\*\*[\s\S]*"chain": "rami_levy"/,
    /\*\*Affected files\*\*[\s\S]*price7290058140886-039-202607151000\.gz/,
    /\*\*Error\*\*[\s\S]*incorrect header check/,
    /<summary>Stack trace<\/summary>/,
    /\*\*Execution logs\*\*[\s\S]*https:\/\/github\.com\/o\/r\/actions\/runs\/1[\s\S]*`sfo1::abc`/,
  ]) {
    assert.match(body, expected);
  }
});

test('a repeat occurrence comments on the open issue instead of opening a duplicate', async () => {
  const gh = new FakeGitHub();
  await reportSyncFailures([gzipFailure('039')], ctx, config(gh));
  const second = await reportSyncFailures(
    [gzipFailure('039')],
    { ...ctx, executedAt: '2026-10-11T15:17:44.000Z' },
    config(gh),
  );

  assert.equal(gh.issues.length, 1);
  assert.equal(gh.comments.length, 1);
  assert.equal(gh.comments[0].issue, 1);
  assert.match(gh.comments[0].body, /2026-10-11T15:17:44\.000Z/);
  assert.match(gh.comments[0].body, /\*\*Error\*\*/);
  assert.deepEqual(second.issues.map((i) => i.action), ['commented']);
});

test('a closed issue is not reused — a recurrence opens a new one', async () => {
  const gh = new FakeGitHub();
  await reportSyncFailures([gzipFailure('039')], ctx, config(gh));
  gh.issues[0].state = 'closed';
  await reportSyncFailures([gzipFailure('039')], ctx, config(gh));
  assert.equal(gh.issues.length, 2);
  assert.equal(gh.comments.length, 0);
});

test('one failing group does not stop the others', async () => {
  const gh = new FakeGitHub();
  gh.failOn = { pattern: /POST \/repos\/o\/r\/issues$/, status: 500 };
  await reportSyncFailures([gzipFailure('039')], ctx, { ...config(gh) }).catch(() => undefined);
  // Seed an open issue for the login problem so it is commented on, while the
  // create for the other problem fails.
  const login = buildFailure('full', { level: 'flow', error: tagStage(new Error('fetch failed'), 'login'), chain: 'osher_ad' });
  gh.issues.push({ number: 7, title: 't', body: markerFor(login.fingerprint), labels: [ISSUE_LABEL], html_url: 'u', state: 'open' });
  const result = await reportSyncFailures([gzipFailure('039'), login], ctx, config(gh));
  assert.equal(result.status, 'partial');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /500/);
  assert.equal(gh.comments.length, 1);
});

test('reportSyncFailuresSafely never throws: network errors, auth errors, timeouts', async () => {
  const failures = [gzipFailure('039')];

  const down = new FakeGitHub();
  down.throwOn = /.*/;
  const r1 = await reportSyncFailuresSafely(failures, ctx, config(down));
  assert.equal(r1.status, 'failed');
  assert.match(r1.errors[0], /fetch failed/);

  const unauthorized = new FakeGitHub();
  unauthorized.failOn = { pattern: /.*/, status: 401 };
  const r2 = await reportSyncFailuresSafely(failures, ctx, config(unauthorized));
  assert.equal(r2.status, 'failed');
  assert.match(r2.errors[0], /401/);

  // Never responds; only the reporter's own abort signal ends it. (The ref'd
  // timer stands in for the open socket that keeps a real process alive.)
  const hanging = (async (_url: string, init: any) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => undefined, 10_000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      });
    })) as unknown as typeof fetch;
  const started = Date.now();
  const r3 = await reportSyncFailuresSafely(failures, ctx, { token: 't', repo: 'o/r', fetchImpl: hanging, timeoutMs: 200 });
  assert.equal(r3.status, 'failed');
  assert.ok(Date.now() - started < 5000, 'bounded by timeoutMs');
});

test('reportSyncFailuresSafely is a no-op without failures or config', async () => {
  assert.equal((await reportSyncFailuresSafely([], ctx, null)).status, 'none');
  assert.equal((await reportSyncFailuresSafely([gzipFailure('039')], ctx, null)).status, 'disabled');
});

test('config comes from SYNC_ISSUES_* first, then the Actions and Vercel variables', () => {
  assert.equal(issueReporterConfigFromEnv({}), null);
  assert.deepEqual(issueReporterConfigFromEnv({ SYNC_ISSUES_GITHUB_TOKEN: 'a', SYNC_ISSUES_GITHUB_REPO: 'o/r' }), {
    token: 'a',
    repo: 'o/r',
    apiUrl: 'https://api.github.com',
  });
  assert.equal(issueReporterConfigFromEnv({ GITHUB_TOKEN: 'b', GITHUB_REPOSITORY: 'o/r2' })?.repo, 'o/r2');
  assert.equal(
    issueReporterConfigFromEnv({ SYNC_ISSUES_GITHUB_TOKEN: 'a', VERCEL_GIT_REPO_OWNER: 'o', VERCEL_GIT_REPO_SLUG: 'r3' })?.repo,
    'o/r3',
  );
  assert.equal(issueReporterConfigFromEnv({ SYNC_ISSUES_GITHUB_TOKEN: 'a', SYNC_ISSUES_GITHUB_REPO: 'not a repo' }), null);
});

test('error text cannot mention users or link issues from the title, nor break out of its code block', () => {
  const f = buildFailure('full', { level: 'flow', error: new Error('ping @someone see #12 ```injected```'), chain: 'tiv_taam' });
  const title = renderIssueTitle([f]);
  assert.ok(title.includes('@\u200bsomeone') && title.includes('#\u200b12'));
  // Inside the body the message only appears in fenced blocks (where GitHub
  // doesn't notify), with a fence longer than any backtick run it contains.
  assert.match(renderIssueBody([f], ctx), /````text\nping @someone see #12 ```injected```\n````/);
});

test('the sync-failure label is created before the first issue, and an existing label is fine', async () => {
  const gh = new FakeGitHub();
  await reportSyncFailures([gzipFailure('039')], ctx, config(gh));
  assert.deepEqual(gh.labels, [ISSUE_LABEL]);

  const again = new FakeGitHub();
  again.labels = [ISSUE_LABEL]; // POST /labels → 422
  const result = await reportSyncFailures([gzipFailure('039')], ctx, config(again));
  assert.equal(result.status, 'reported');
  assert.equal(again.issues.length, 1);
});
