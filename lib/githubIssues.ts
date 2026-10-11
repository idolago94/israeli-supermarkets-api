import { SyncFailure, normalizeMessage } from './syncFailures';

// ─── GitHub issue reporting for sync failures ─────────────────────────────────
//
// Turns SyncFailures into GitHub issues in this repository, one issue per
// underlying problem: failures sharing a fingerprint (same flow, level, stage,
// chain and normalised error — see failureFingerprint) are grouped, and a
// problem that already has an open issue gets a comment with the new
// occurrence instead of a duplicate issue. Every occurrence's details stay on
// the issue, as the opening body or as a comment.
//
// Uses the REST API over the global fetch — no Octokit dependency. Used both
// by the sync endpoints on Vercel (lib/syncEndpoint.ts) and by the scheduler's
// fallback step (scripts/report-sync-failures.ts), so like syncFailures.ts it
// imports nothing that needs a database.
//
// Reporting is strictly best-effort: reportSyncFailuresSafely never throws, is
// bounded by a deadline, and only logs its own problems — a GitHub outage or a
// bad token must never change a sync's outcome or hide its original error.

export const ISSUE_LABEL = 'sync-failure';
const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const PER_REQUEST_TIMEOUT_MS = 10_000;
/** GitHub rejects issue/comment bodies over 65536 characters. */
const MAX_BODY_CHARS = 60_000;
const MAX_LISTED_FILES = 40;
const MAX_OPEN_ISSUE_PAGES = 5;

export interface IssueReporterConfig {
  token: string;
  /** "owner/name" */
  repo: string;
  apiUrl?: string;
  label?: string;
  /** Overall budget for one report (every request together). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Reads the reporter config from the environment; null when reporting isn't
 * configured (it's optional — syncs run the same without it).
 *   token: SYNC_ISSUES_GITHUB_TOKEN, else GITHUB_TOKEN (set in GitHub Actions)
 *   repo:  SYNC_ISSUES_GITHUB_REPO, else GITHUB_REPOSITORY (Actions), else
 *          VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG (Vercel system env vars)
 */
export function issueReporterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IssueReporterConfig | null {
  const token = env.SYNC_ISSUES_GITHUB_TOKEN || env.GITHUB_TOKEN || '';
  const repo =
    env.SYNC_ISSUES_GITHUB_REPO ||
    env.GITHUB_REPOSITORY ||
    (env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG
      ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`
      : '');
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { token, repo, apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL };
}

/** Everything about the run that isn't specific to one failure. */
export interface ReportContext {
  /** Parameters the flow ran with (mode, chain, force, …). */
  params: Record<string, unknown>;
  /** ISO time the run started. */
  executedAt: string;
  /** Who observed the failure, e.g. "sync endpoint (Vercel)". */
  source: string;
  /** Log references: Actions run URL, Vercel request id, … */
  logs?: { label: string; value: string }[];
  /** Any further run facts (HTTP status, attempts, outcome). */
  details?: Record<string, string>;
}

export type IssueReportStatus = 'none' | 'disabled' | 'delegated' | 'reported' | 'partial' | 'failed';

export interface IssueReportResult {
  status: IssueReportStatus;
  issues: { fingerprint: string; number: number; url: string; action: 'created' | 'commented' }[];
  errors: string[];
}

// ─── Markdown rendering ───────────────────────────────────────────────────────

/** A code block whose fence can't be closed early by backticks in `text`. */
function codeBlock(text: string, lang = 'text'): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Inline code safe for table cells. */
function inline(text: string): string {
  const clean = text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return clean.includes('`') ? `<code>${clean.replace(/</g, '&lt;')}</code>` : `\`${clean}\``;
}

/** Keeps an error message from @-mentioning anyone or linking issues by #. */
function neutralize(text: string): string {
  return text.replace(/@(?=\w)/g, '@​').replace(/#(?=\d)/g, '#​');
}

function uniq<T>(items: (T | undefined)[]): T[] {
  return [...new Set(items.filter((x): x is T => x !== undefined && x !== ''))];
}

export function markerFor(fingerprint: string): string {
  return `<!-- sync-failure:fingerprint=${fingerprint} -->`;
}

export function renderIssueTitle(group: SyncFailure[]): string {
  const f = group[0];
  const summary = f.message.split('; body starts:')[0].split('\n')[0].trim();
  const short = summary.length > 110 ? `${summary.slice(0, 110)}…` : summary;
  return neutralize(`Sync failure: ${f.flow} / ${f.chain ?? 'all chains'} — ${f.stage}: ${short}`);
}

/** The details of one run's occurrence of a problem — the opening issue body
 *  carries the first one, each later run adds one as a comment. */
export function renderOccurrence(group: SyncFailure[], ctx: ReportContext): string {
  const f = group[0];
  const stores = uniq(group.map((g) => g.storeId));
  const files = uniq(group.map((g) => g.file));
  const times = group.map((g) => g.occurredAt).sort();
  const levelText =
    f.level === 'file'
      ? 'file — the flow carried on without the affected files'
      : 'flow — the flow failed for this chain';

  const rows: [string, string][] = [
    ['Flow', inline(f.flow)],
    ['Failed stage', inline(f.stage)],
    ['Level', levelText],
    ['Chain', f.chain ? inline(f.chain) : '_n/a_'],
    ['Store IDs', stores.length ? stores.map(inline).join(', ') : '_n/a_'],
    ['Failures in this run', String(group.length)],
    ['Execution started', inline(ctx.executedAt)],
    ['Failure recorded', times.length > 1 ? `${inline(times[0])} … ${inline(times[times.length - 1])}` : inline(times[0])],
    ['Reported by', ctx.source],
    ...Object.entries(ctx.details ?? {}).map(([k, v]): [string, string] => [k, inline(v)]),
  ];

  const parts: string[] = [
    `### Occurrence — ${times[0]}`,
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '**Execution parameters**',
    '',
    codeBlock(JSON.stringify(ctx.params, null, 2), 'json'),
  ];

  if (files.length) {
    const listed = group
      .filter((g) => g.file)
      .slice(0, MAX_LISTED_FILES)
      .map((g) => `- ${inline(g.file as string)}${g.storeId ? ` — store ${inline(g.storeId)}` : ''}`);
    const more = files.length > MAX_LISTED_FILES ? [`- …and ${files.length - MAX_LISTED_FILES} more`] : [];
    parts.push('', '**Affected files**', '', ...listed, ...more);
  }

  parts.push('', '**Error**', '', codeBlock(f.message));
  const otherMessages = uniq(group.slice(1).map((g) => (g.message !== f.message ? g.message : undefined)));
  if (otherMessages.length) {
    parts.push(
      '',
      `<details><summary>${otherMessages.length} other message variant(s) in this run</summary>`,
      '',
      codeBlock(otherMessages.slice(0, 10).join('\n\n')),
      '',
      '</details>',
    );
  }
  if (f.cause) parts.push('', `**Cause:** ${inline(f.cause)}`);
  if (f.stack) {
    parts.push('', '<details><summary>Stack trace</summary>', '', codeBlock(f.stack), '', '</details>');
  } else {
    parts.push('', '_No stack trace available._');
  }

  parts.push('', '**Execution logs**', '');
  if (ctx.logs?.length) {
    parts.push(...ctx.logs.map((l) => `- ${l.label}: ${/^https?:\/\//.test(l.value) ? l.value : inline(l.value)}`));
  } else {
    parts.push('- _No log reference available for this run._');
  }

  return parts.join('\n');
}

export function renderIssueBody(group: SyncFailure[], ctx: ReportContext): string {
  const f = group[0];
  return [
    markerFor(f.fingerprint),
    '## Catalog sync failure',
    '',
    'Opened automatically by the catalog sync. Later occurrences of the same problem — same flow, stage, ' +
      'chain and error — are added below as comments instead of opening new issues. Close this issue once ' +
      'the problem is fixed; a recurrence after that opens a new one.',
    '',
    `**Fingerprint:** ${inline(f.fingerprint)}  `,
    `**Normalised error:** ${inline(normalizeMessage(f.message))}`,
    '',
    renderOccurrence(group, ctx),
  ].join('\n');
}

function clampBody(body: string): string {
  return body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}\n\n…_truncated (${body.length - MAX_BODY_CHARS} more characters)_`
    : body;
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

interface OpenIssue {
  number: number;
  html_url: string;
  body?: string | null;
  pull_request?: unknown;
}

class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly deadline: number;

  constructor(private readonly config: IssueReporterConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.deadline = Date.now() + (config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error('issue reporting deadline exceeded');
    const res = await this.fetchImpl(`${this.config.apiUrl ?? DEFAULT_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'israeli-supermarkets-api-sync-reporter',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(Math.min(remaining, PER_REQUEST_TIMEOUT_MS)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Creates the label on first use; "already exists" (422) and any other
   *  failure are ignored — creating the issue reports real problems. */
  async ensureLabel(label: string): Promise<void> {
    try {
      await this.request('POST', `/repos/${this.config.repo}/labels`, {
        name: label,
        color: 'd73a4a',
        description: 'Opened automatically by the catalog sync on a sync failure',
      });
    } catch {
      // exists already, or no permission to manage labels
    }
  }

  async openIssues(label: string): Promise<OpenIssue[]> {
    const all: OpenIssue[] = [];
    for (let page = 1; page <= MAX_OPEN_ISSUE_PAGES; page++) {
      const batch = await this.request<OpenIssue[]>(
        'GET',
        `/repos/${this.config.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`,
      );
      all.push(...batch.filter((i) => !i.pull_request));
      if (batch.length < 100) break;
    }
    return all;
  }
}

export function groupByFingerprint(failures: SyncFailure[]): SyncFailure[][] {
  const groups = new Map<string, SyncFailure[]>();
  for (const f of failures) groups.set(f.fingerprint, [...(groups.get(f.fingerprint) ?? []), f]);
  return [...groups.values()];
}

/**
 * Files one issue (or one comment on the matching open issue) per distinct
 * problem in `failures`. Each group is independent: one failing API call is
 * recorded in `errors` and the rest still get reported. Throws only if the
 * open-issue lookup itself fails — use reportSyncFailuresSafely from sync code.
 */
export async function reportSyncFailures(
  failures: SyncFailure[],
  ctx: ReportContext,
  config: IssueReporterConfig,
): Promise<IssueReportResult> {
  const result: IssueReportResult = { status: 'none', issues: [], errors: [] };
  if (!failures.length) return result;

  const label = config.label ?? ISSUE_LABEL;
  const gh = new GitHubClient(config);
  const open = await gh.openIssues(label);
  let labelChecked = open.length > 0;

  for (const group of groupByFingerprint(failures)) {
    const fingerprint = group[0].fingerprint;
    try {
      const existing = open.find((i) => (i.body ?? '').includes(markerFor(fingerprint)));
      if (existing) {
        await gh.request('POST', `/repos/${config.repo}/issues/${existing.number}/comments`, {
          body: clampBody(`${markerFor(fingerprint)}\n${renderOccurrence(group, ctx)}`),
        });
        result.issues.push({ fingerprint, number: existing.number, url: existing.html_url, action: 'commented' });
      } else {
        if (!labelChecked) {
          await gh.ensureLabel(label);
          labelChecked = true;
        }
        const created = await gh.request<OpenIssue>('POST', `/repos/${config.repo}/issues`, {
          title: renderIssueTitle(group),
          body: clampBody(renderIssueBody(group, ctx)),
          labels: [label],
        });
        open.push(created);
        result.issues.push({ fingerprint, number: created.number, url: created.html_url, action: 'created' });
      }
    } catch (err) {
      const msg = `fingerprint ${fingerprint}: ${err}`;
      result.errors.push(msg);
      console.error(`[sync-issues] failed to report ${msg}`);
    }
  }

  result.status = result.errors.length === 0 ? 'reported' : result.issues.length ? 'partial' : 'failed';
  return result;
}

/**
 * The entry point for sync code: never throws, and logs (rather than raises)
 * anything that goes wrong while talking to GitHub. `config` defaults to the
 * environment; null means reporting is not configured.
 */
export async function reportSyncFailuresSafely(
  failures: SyncFailure[],
  ctx: ReportContext,
  config: IssueReporterConfig | null = issueReporterConfigFromEnv(),
): Promise<IssueReportResult> {
  if (!failures.length) return { status: 'none', issues: [], errors: [] };
  if (!config) {
    console.warn(
      `[sync-issues] ${failures.length} sync failure(s) not reported: GitHub issue reporting is not configured ` +
        '(set SYNC_ISSUES_GITHUB_TOKEN and SYNC_ISSUES_GITHUB_REPO)',
    );
    return { status: 'disabled', issues: [], errors: [] };
  }
  try {
    const result = await reportSyncFailures(failures, ctx, config);
    for (const i of result.issues) console.log(`[sync-issues] ${i.action === 'created' ? 'created' : 'commented on'} issue #${i.number} (${i.fingerprint})`);
    return result;
  } catch (err) {
    console.error(`[sync-issues] issue reporting failed: ${err}`);
    return { status: 'failed', issues: [], errors: [String(err)] };
  }
}
