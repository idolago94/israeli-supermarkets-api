// Catalog sync dashboard — a small hash-routed single-page app over /api.
// No build step: plain DOM + template strings. Every interpolated value goes
// through esc() unless it is markup this file built itself.
'use strict';

const app = document.getElementById('app');
let tz = 'Asia/Jerusalem';
let chains = [];
let currentRender = null; // re-run by live updates
let renderToken = 0;

// ─── helpers ────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-sync-dashboard': '1', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = ''), 4000);
}

function fmtTime(ms, withDate = true) {
  if (!ms) return '—';
  const d = new Date(ms);
  const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withDate) Object.assign(opts, { day: 'numeric', month: 'short' });
  return d.toLocaleString('en-GB', opts);
}
function fmtSeconds(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hourCycle: 'h23' });
}
function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtRel(ms, now = Date.now()) {
  const d = ms - now;
  const a = Math.abs(d);
  const unit = a < 3600e3 ? [Math.round(a / 60e3), 'min'] : a < 48 * 3600e3 ? [Math.round(a / 3600e3), 'h'] : [Math.round(a / 86400e3), 'd'];
  return d >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

const STATUS_LABEL = {
  running: 'Running', succeeded: 'Succeeded', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled',
  skipped: 'Skipped', queued: 'Queued', retry_wait: 'Retrying',
};
const status = (s) => `<span class="status s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
const chainName = (id) => {
  const c = chains.find((x) => x.id === id);
  return c ? `${esc(c.name)} <span class="muted small">${esc(id)}</span>` : esc(id);
};
const TYPE_LABEL = { full: 'Full', deltas: 'Deltas', stores: 'Branch list' };
const TRIGGER_LABEL = { schedule: 'Scheduled', manual: 'Manual', retry: 'Retry', replay: 'Replay' };

function progressBar(c) {
  const total = c.total || 1;
  const parts = ['succeeded', 'skipped', 'failed', 'running', 'retry_wait', 'cancelled']
    .filter((k) => c[k])
    .map((k) => `<span class="p-${k}" style="width:${(c[k] / total) * 100}%" title="${esc(STATUS_LABEL[k])}: ${c[k]}"></span>`);
  return `<div class="progress" role="img" aria-label="${c.succeeded + c.skipped + c.failed + c.cancelled} of ${c.total} branches finished">${parts.join('')}</div>`;
}
function countsLine(c) {
  const items = [
    ['succeeded', 'succeeded'], ['skipped', 'skipped'], ['failed', 'failed'],
    ['running', 'running'], ['retry_wait', 'retrying'], ['queued', 'queued'], ['cancelled', 'cancelled'],
  ].filter(([k]) => c[k]);
  if (!items.length) return '<span class="muted">No branches</span>';
  return `<div class="counts">${items.map(([k, l]) => `<span><b>${n(c[k])}</b> ${l}</span>`).join('')}</div>`;
}

function branchSummary(b) {
  const parts = [];
  if (b.succeeded) parts.push(`${n(b.succeeded)} written`);
  if (b.skipped) parts.push(`${n(b.skipped)} unchanged`);
  if (b.failed) parts.push(`<span class="lvl-error">${n(b.failed)} failed</span>`);
  if (b.cancelled) parts.push(`${n(b.cancelled)} cancelled`);
  return parts.join(', ') || '—';
}

function runsTable(runs) {
  if (!runs.length) return '<p class="empty">No runs yet. Start one, or wait for the schedule.</p>';
  return `<div class="table-wrap"><table>
    <thead><tr><th>Run</th><th>Type</th><th>Status</th><th>Started</th><th class="num">Took</th><th class="hide-sm">Branches</th><th class="hide-sm">Price changes</th></tr></thead>
    <tbody>${runs.map((r) => {
      const b = (r.summary && r.summary.branches) || {};
      return `<tr class="clickable" data-href="#/runs/${r.id}">
        <td><a href="#/runs/${r.id}">#${r.id}</a> <span class="muted small">${esc(TRIGGER_LABEL[r.trigger] || r.trigger)}</span></td>
        <td>${esc(TYPE_LABEL[r.type] || r.type)}</td>
        <td>${status(r.status)}${r.status === 'skipped' && r.reason ? `<div class="muted small">${esc(r.reason)}</div>` : ''}</td>
        <td class="nowrap">${fmtTime(r.started_at || r.created_at)}</td>
        <td class="num nowrap">${r.status === 'skipped' ? '—' : fmtDur(r.duration_ms)}</td>
        <td class="hide-sm">${b.total ? branchSummary(b) : '<span class="muted">—</span>'}</td>
        <td class="hide-sm num">${r.summary && r.summary.priceChanges != null ? n(r.summary.priceChanges) : '—'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function bindRowLinks(root) {
  root.querySelectorAll('tr[data-href]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      location.hash = tr.dataset.href;
    }),
  );
}

async function act(btn, fn, okMsg) {
  btn.disabled = true;
  try {
    const r = await fn();
    toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    if (r && r.runId) location.hash = `#/runs/${r.runId}`;
    else refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ─── Home ───────────────────────────────────────────────────────────────────

async function renderHome() {
  const o = await api('/overview');
  tz = o.timezone;
  chains = o.chains;
  renderHealth(o.health);

  const a = o.active;
  const nextUp = o.schedules.filter((s) => s.next_at).sort((x, y) => x.next_at - y.next_at)[0];
  const now = `
    <section class="panel now-card">
      ${a ? `
        <div class="row spread">
          <h2><a href="#/runs/${a.run.id}">${esc(TYPE_LABEL[a.run.type])} run #${a.run.id}</a></h2>
          <div class="row">${status('running')}<button class="danger" id="cancel">Cancel run</button></div>
        </div>
        <div class="facts" style="margin:6px 0 12px">
          <span>Started <b>${fmtTime(a.run.started_at)}</b></span>
          <span>Running for <b>${fmtDur(a.elapsed_ms)}</b></span>
          <span>${esc(TRIGGER_LABEL[a.run.trigger])}</span>
        </div>
        ${a.long_running ? `<p class="lvl-warn">This run has been going over ${o.long_run_warn_minutes} minutes.</p>` : ''}
        ${progressBar(a.counts)}
        <div style="margin-top:8px">${countsLine(a.counts)}</div>
        <div class="chain-lines">${a.chains.map((c) => `
          <div class="chain-line">
            <div>${chainName(c.chain_id)}</div>
            ${progressBar(c.counts)}
            <div class="small">${c.status === 'running' ? `<span class="muted">${esc(c.current_step === 'branches' ? 'processing branches' : c.current_step || 'starting')}</span>` : status(c.status)}</div>
          </div>`).join('')}
        </div>`
      : `
        <h2>Nothing is running</h2>
        <p class="muted" style="margin:6px 0 0">${nextUp ? `Next: ${esc(TYPE_LABEL[nextUp.run_type])} at <b>${fmtTime(nextUp.next_at, false)}</b> (${fmtRel(nextUp.next_at, o.now)}).` : 'Every schedule is paused.'}</p>`}
    </section>`;

  app.innerHTML = `
    <div class="split">
      <div class="stack">
        ${now}
        <section class="panel"><h2>Recent runs</h2>${runsTable(o.recent)}
          <p class="small" style="margin:12px 0 0"><a href="#/runs">All runs</a></p></section>
      </div>
      <aside class="stack">
        <section class="panel">
          <h2>Start a run</h2>
          <form id="start" class="stack">
            <label class="field"><span>Type</span>
              <select name="type">
                <option value="deltas">Deltas: new intraday price files</option>
                <option value="full">Full: every branch's PriceFull</option>
                <option value="stores">Branch list only</option>
              </select></label>
            <div class="field"><span>Chains</span>
              <div class="checks">${o.chains.map((c) => `<label><input type="checkbox" name="chain" value="${esc(c.id)}" checked> ${esc(c.name)}</label>`).join('')}</div></div>
            <label class="row"><input type="checkbox" name="force"> Reprocess unchanged branches</label>
            <button class="primary" type="submit" ${a ? 'disabled title="A run is in progress"' : ''}>Start run</button>
          </form>
        </section>
        <section class="panel">
          <h2>Schedule</h2>
          <table><tbody>${o.schedules.map((s) => `
            <tr><td>${esc(TYPE_LABEL[s.run_type])}<div class="muted small mono">${esc(s.cron)}</div></td>
            <td class="num">${s.paused ? '<span class="status s-cancelled">Paused</span>' : `${fmtTime(s.next_at, false)}<div class="muted small">${fmtRel(s.next_at, o.now)}</div>`}</td></tr>`).join('')}
          </tbody></table>
          <p class="small" style="margin:10px 0 0"><a href="#/schedules">Edit schedule</a> <span class="muted">(times in ${esc(tz)})</span></p>
        </section>
      </aside>
    </div>`;

  bindRowLinks(app);
  const cancel = document.getElementById('cancel');
  if (cancel) cancel.onclick = () => confirm(`Cancel run #${a.run.id}? Branches already written stay written.`) &&
    act(cancel, () => post(`/runs/${a.run.id}/cancel`), 'Run cancelled');
  document.getElementById('start').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const picked = f.getAll('chain');
    if (!picked.length) return toast('Pick at least one chain', true);
    act(e.submitter, () => post('/runs', {
      type: f.get('type'),
      chains: picked.length === o.chains.length ? undefined : picked,
      force: f.get('force') === 'on',
    }), (r) => `Run #${r.runId} started`);
  };
}

function renderHealth(h) {
  const el = document.getElementById('health');
  el.innerHTML = (h.warnings || []).map((w) => `<div class="warning ${w.level === 'warn' ? 'warn' : ''}">${esc(w.message)}</div>`).join('');
}

// ─── Runs list ──────────────────────────────────────────────────────────────

async function renderRuns(q) {
  const type = q.get('type') || '';
  const st = q.get('status') || '';
  const runs = await api(`/runs?limit=200${type ? `&type=${type}` : ''}${st ? `&status=${st}` : ''}`);
  app.innerHTML = `
    <div class="page-head"><h1>All runs</h1>
      <form class="row" id="f">
        <select name="type"><option value="">Every type</option>${['full', 'deltas', 'stores'].map((t) => `<option value="${t}" ${t === type ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select>
        <select name="status"><option value="">Every status</option>${['running', 'succeeded', 'partial', 'failed', 'cancelled', 'skipped'].map((s) => `<option value="${s}" ${s === st ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
      </form></div>
    <section class="panel">${runsTable(runs)}</section>`;
  bindRowLinks(app);
  document.getElementById('f').onchange = (e) => {
    const f = new FormData(e.currentTarget);
    location.hash = `#/runs?type=${f.get('type')}&status=${f.get('status')}`;
  };
}

// ─── Run ────────────────────────────────────────────────────────────────────

const CHAIN_STEP_ORDER = ['login', 'stores-file', 'list-files', 'recompute-names'];

function chainStepChips(steps) {
  if (!steps.length) return '';
  return `<div class="steps-inline">${steps.map((s) => `<span class="chip c-${esc(s.status)}" title="${esc(s.error || '')}">${esc(s.name)}${s.attempt > 1 ? ` #${s.attempt}` : ''} ${s.status === 'running' ? '…' : s.status === 'failed' ? 'failed' : fmtDur(s.duration_ms)}</span>`).join('')}</div>`;
}

async function renderRun(id) {
  const d = await api(`/runs/${id}`);
  const r = d.run;
  tz = tz || 'Asia/Jerusalem';
  const tasksByJob = {};
  for (const t of d.tasks) (tasksByJob[t.chain_job_id] ||= []).push(t);
  const failedTasks = d.tasks.filter((t) => t.status === 'failed');
  const canRetry = ['partial', 'failed', 'cancelled'].includes(r.status);

  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="crumbs"><a href="#/">Runs</a></div>
        <h1>${esc(TYPE_LABEL[r.type])} run #${r.id}</h1>
        <div class="facts">
          <span>${status(r.status)}</span>
          <span>${esc(TRIGGER_LABEL[r.trigger])}${r.schedule_name ? ` (${esc(r.schedule_name)})` : ''}</span>
          <span>Started <b>${fmtTime(r.started_at || r.created_at)}</b></span>
          <span>${r.status === 'running' ? 'Running for' : 'Took'} <b>${fmtDur(r.duration_ms ?? Date.now() - (r.started_at || r.created_at))}</b></span>
          ${d.parent ? `<span>From <a href="#/runs/${d.parent.id}">run #${d.parent.id}</a></span>` : ''}
          ${d.children.map((c) => `<span>${esc(TRIGGER_LABEL[c.trigger])}: <a href="#/runs/${c.id}">run #${c.id}</a></span>`).join('')}
        </div>
        ${r.reason ? `<p class="muted small" style="margin:6px 0 0">${esc(r.reason)}</p>` : ''}
        ${r.params && (r.params.force || r.params.dryRun || r.params.stores) ? `<p class="muted small mono" style="margin:4px 0 0">${esc(JSON.stringify(r.params))}</p>` : ''}
      </div>
      <div class="row">
        ${r.status === 'running' ? '<button class="danger" id="cancel">Cancel run</button>' : ''}
        ${canRetry ? '<button id="retry-failed">Retry what failed</button>' : ''}
        <a class="btn" href="#/logs?run=${r.id}">Logs</a>
      </div>
    </div>

    <section class="panel">
      <div class="row spread" style="margin-bottom:10px">
        ${countsLine(d.counts)}
        <div class="legend">
          <span><i style="background:var(--ok)"></i>Written</span>
          <span><i style="background:var(--skip)"></i>Unchanged</span>
          <span><i style="background:var(--run);box-shadow:inset 0 -3px 0 var(--tag)"></i>Running</span>
          <span><i style="background:var(--retry)"></i>Retrying</span>
          <span><i style="background:var(--fail)"></i>Failed</span>
          <span><i style="background:var(--queued)"></i>Queued</span>
        </div>
      </div>
      ${d.counts.total ? progressBar(d.counts) : ''}
      ${d.chains.map((c) => {
        const tasks = tasksByJob[c.id] || [];
        const steps = c.steps.slice().sort((x, y) => x.id - y.id);
        return `<div class="shelf">
          <div class="shelf-head">
            <h3>${chainName(c.chain_id)}</h3>
            <div class="row small">
              ${status(c.status)}
              ${c.status === 'running' && c.current_step ? `<span class="muted">now: ${esc(c.current_step === 'branches' ? 'processing branches' : c.current_step)}</span>` : ''}
              ${c.duration_ms != null ? `<span class="muted">${fmtDur(c.duration_ms)}</span>` : ''}
              ${['failed', 'partial', 'cancelled'].includes(c.status) && r.status !== 'running' ? `<button data-retry-chain="${c.id}">Retry chain</button>` : ''}
            </div>
          </div>
          ${chainStepChips(steps)}
          ${c.error ? `<div class="errorbox" style="margin-bottom:10px"><b>Chain failed at ${esc(c.error_stage)}</b><p>${esc(c.error)}</p></div>` : ''}
          ${tasks.length ? `<div class="tags">${tasks.map((t) => `
            <a class="tagcell t-${esc(t.status)}" href="#/tasks/${t.id}"
               title="${esc(`Branch ${t.store_code}: ${STATUS_LABEL[t.status]}${t.current_step ? ` (${t.current_step})` : ''}${t.skip_reason ? ` (${t.skip_reason})` : ''}${t.error ? `\n${t.error_stage}: ${t.error}` : ''}`)}">
              ${esc(t.store_code)}${t.attempts > 1 ? `<span class="att">×${t.attempts}</span>` : ''}</a>`).join('')}</div>`
          : r.type === 'stores' ? '' : '<p class="muted small">No branches enqueued.</p>'}
          ${c.summary && c.summary.files ? `<p class="muted small" style="margin:8px 0 0">${n(c.summary.files)} files, ${fmtBytes(c.summary.bytes)}, ${n(c.summary.items)} items, ${n(c.summary.rowsWritten)} rows written, ${n(c.summary.priceChanges)} price changes, ${n(c.summary.rowsDeleted)} removed</p>` : ''}
        </div>`;
      }).join('')}
    </section>

    ${failedTasks.length ? `<section class="panel" style="margin-top:20px"><h2>Failed branches</h2>
      <div class="table-wrap"><table><thead><tr><th>Branch</th><th>Step</th><th>Error</th><th class="num">Attempts</th></tr></thead><tbody>
      ${failedTasks.map((t) => `<tr class="clickable" data-href="#/tasks/${t.id}"><td><a href="#/tasks/${t.id}">${esc(t.chain_id)}/${esc(t.store_code)}</a></td>
        <td>${esc(t.error_stage)}</td><td>${esc(t.error)}</td><td class="num">${t.attempts}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}`;

  bindRowLinks(app);
  const cancel = document.getElementById('cancel');
  if (cancel) cancel.onclick = () => confirm(`Cancel run #${r.id}?`) && act(cancel, () => post(`/runs/${r.id}/cancel`), 'Run cancelled');
  const rf = document.getElementById('retry-failed');
  if (rf) rf.onclick = () => act(rf, () => post(`/runs/${r.id}/retry-failed`), (x) => `Retry run #${x.runId} started`);
  app.querySelectorAll('[data-retry-chain]').forEach((b) =>
    (b.onclick = () => act(b, () => post(`/chain-jobs/${b.dataset.retryChain}/retry`), (x) => `Retry run #${x.runId} started`)));
}

// ─── Branch task ────────────────────────────────────────────────────────────

function timeline(steps) {
  if (!steps.length) return '<p class="muted">No steps recorded.</p>';
  const start = Math.min(...steps.map((s) => s.started_at));
  const end = Math.max(...steps.map((s) => s.finished_at || Date.now()));
  const span = Math.max(1, end - start);
  let lastAttempt = null;
  return `<div class="timeline">${steps.map((s) => {
    const left = ((s.started_at - start) / span) * 100;
    const width = (((s.finished_at || Date.now()) - s.started_at) / span) * 100;
    const head = s.attempt !== lastAttempt ? `<div class="attempt-head">Attempt ${s.attempt}</div>` : '';
    lastAttempt = s.attempt;
    const m = Object.entries(s.metrics || {}).map(([k, v]) => `${k}: ${typeof v === 'number' && k.toLowerCase().includes('bytes') ? fmtBytes(v) : esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(', ');
    return `${head}<div class="tl-row">
      <div>${esc(s.name)}</div>
      <div class="tl-track"><span class="tl-bar b-${esc(s.status)}" style="left:${left}%;width:${Math.max(width, 0.4)}%"></span></div>
      <div class="num small">${s.status === 'skipped' ? 'skipped' : s.status === 'running' ? 'running' : fmtDur(s.duration_ms)}</div>
      ${m || s.error || s.file ? `<div class="tl-meta">${s.error ? `<span class="lvl-error">${esc(s.error)}</span> ` : ''}${m}${s.file && s.name === 'download' ? ` <span class="mono">${esc(s.file)}</span>` : ''}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function logTable(logs, showLinks) {
  if (!logs.length) return '<p class="empty">No log lines.</p>';
  return `<div class="table-wrap"><table class="logs"><tbody>${logs.map((l) => {
    let ctx = '';
    try {
      const c = JSON.parse(l.context || '{}');
      ctx = Object.keys(c).length ? JSON.stringify(c) : '';
    } catch { ctx = l.context; }
    return `<tr>
      <td class="muted">${fmtSeconds(l.ts)}</td>
      <td class="lvl lvl-${esc(l.level)}">${esc(l.level)}</td>
      ${showLinks ? `<td class="small">${l.run_id ? `<a href="#/runs/${l.run_id}">#${l.run_id}</a>` : ''} ${esc(l.chain_id || '')}${l.branch_task_id ? ` <a href="#/tasks/${l.branch_task_id}">task ${l.branch_task_id}</a>` : ''}</td>` : ''}
      <td class="small">${esc(l.step_name || '')}</td>
      <td>${esc(l.msg)}${ctx ? `<div class="ctx mono">${esc(ctx)}</div>` : ''}</td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

async function renderTask(id) {
  const d = await api(`/tasks/${id}`);
  const t = d.task;
  const m = t.metrics || {};
  const finished = !['queued', 'running', 'retry_wait'].includes(t.status);
  const hasRaw = d.raw_files.some((f) => f.available);

  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="crumbs"><a href="#/">Runs</a> / <a href="#/runs/${d.run.id}">${esc(TYPE_LABEL[d.run.type])} run #${d.run.id}</a> / ${chainName(t.chain_id)}</div>
        <h1>Branch ${esc(t.store_code)}</h1>
        <div class="facts">
          <span>${status(t.status)}</span>
          <span>Attempt <b>${t.attempts}</b></span>
          <span>Took <b>${fmtDur(t.duration_ms)}</b></span>
          ${t.item_count != null ? `<span><b>${n(t.item_count)}</b> items</span>` : ''}
          ${m.priceChanges != null ? `<span><b>${n(m.priceChanges)}</b> price changes</span>` : ''}
          ${m.rowsDeleted ? `<span><b>${n(m.rowsDeleted)}</b> removed</span>` : ''}
          ${t.replay_of ? `<span>Replay of <a href="#/tasks/${t.replay_of}">task #${t.replay_of}</a>${t.dry_run ? ' (dry run)' : ''}</span>` : ''}
          ${t.recovered ? '<span>Resumed after a restart</span>' : ''}
          ${t.status === 'retry_wait' ? `<span>Next attempt ${fmtRel(t.next_attempt_at)}</span>` : ''}
        </div>
        ${t.skip_reason ? `<p class="muted" style="margin:6px 0 0">${esc(t.skip_reason)}</p>` : ''}
      </div>
      <div class="row">
        ${finished && d.run.status !== 'running' ? '<button id="retry">Retry branch</button>' : ''}
        ${hasRaw && d.run.status !== 'running' ? '<button id="replay-dry">Replay from file (dry run)</button><button id="replay">Replay and write</button>' : ''}
      </div>
    </div>

    <div class="split">
      <div class="stack">
        ${t.error ? `<section class="errorbox">
          <b>Failed at ${esc(t.error_stage)}</b> <span class="muted small">(${esc(t.error_kind)} error${t.error_kind === 'permanent' ? ', not retried' : ''})</span>
          <p>${esc(t.error)}</p>
          ${t.stack ? `<details><summary>Stack trace</summary><pre>${esc(t.stack)}</pre></details>` : ''}
        </section>` : ''}
        <section class="panel"><h2>Steps</h2>${timeline(d.steps)}</section>
        <section class="panel"><div class="row spread"><h2>Logs</h2><a class="small" href="#/logs?task=${t.id}">Open in log viewer</a></div>${logTable(d.logs, false)}</section>
      </div>
      <aside class="stack">
        <section class="panel"><h2>Files</h2>
          ${t.files.length ? `<ul style="margin:0;padding-left:18px">${t.files.map((f) => `<li class="mono small" style="overflow-wrap:anywhere">${esc(f)}</li>`).join('')}</ul>` : '<p class="muted">None</p>'}
          ${t.head_size || t.head_modified ? `<p class="small muted" style="margin:10px 0 0">HEAD signature: ${esc(t.head_size)} bytes, ${esc(t.head_modified)}</p>` : ''}
          ${d.raw_files.length ? `<h3 style="margin-top:14px">Saved copies</h3><ul style="margin:6px 0 0;padding-left:18px">${d.raw_files.map((f) =>
            `<li class="small">${f.available ? `<a href="/api/raw/${f.id}">${esc(f.file)}</a>` : `<span class="muted">${esc(f.file)} (expired)</span>`} <span class="muted">${fmtBytes(f.size)}</span></li>`).join('')}</ul>` : ''}
        </section>
        ${d.replays.length ? `<section class="panel"><h2>Replays</h2>${d.replays.map((x) => `<div class="row small"><a href="#/tasks/${x.id}">Task #${x.id}</a>${status(x.status)}${x.dry_run ? '<span class="muted">dry run</span>' : ''}</div>`).join('')}</section>` : ''}
        <section class="panel"><h2>This branch over time</h2>
          <table><tbody>${d.history.map((h) => `<tr class="clickable" data-href="#/tasks/${h.id}">
            <td><a href="#/tasks/${h.id}">#${h.run_id}</a> <span class="muted small">${esc(TYPE_LABEL[h.run_type])}</span></td>
            <td>${status(h.status)}</td><td class="num small">${fmtTime(h.finished_at || h.started_at)}</td></tr>`).join('')}</tbody></table>
        </section>
      </aside>
    </div>`;

  bindRowLinks(app);
  const retry = document.getElementById('retry');
  if (retry) retry.onclick = () => act(retry, () => post(`/tasks/${t.id}/retry`), (x) => `Retry run #${x.runId} started`);
  const dry = document.getElementById('replay-dry');
  if (dry) dry.onclick = () => act(dry, () => post(`/tasks/${t.id}/replay`, { dryRun: true }), (x) => `Replay run #${x.runId} started`);
  const rep = document.getElementById('replay');
  if (rep) rep.onclick = () =>
    confirm('Write this saved file to the catalog again? If newer data for this branch exists, it will be replaced by this file.') &&
    act(rep, () => post(`/tasks/${t.id}/replay`, { dryRun: false }), (x) => `Replay run #${x.runId} started`);
}

// ─── Logs ───────────────────────────────────────────────────────────────────

const STEPS = ['login', 'stores-file', 'list-files', 'head-check', 'download', 'decompress', 'parse', 'validate', 'write-db', 'finalize', 'recompute-names'];

async function renderLogs(q) {
  const params = new URLSearchParams();
  for (const k of ['level', 'run', 'chain', 'task', 'step', 'q', 'before']) if (q.get(k)) params.set(k, q.get(k));
  params.set('limit', '300');
  const logs = await api(`/logs?${params}`);
  const v = (k) => esc(q.get(k) || '');
  app.innerHTML = `
    <div class="page-head"><h1>Logs</h1></div>
    <form class="panel filters" id="f">
      <label class="field"><span>Level</span><select name="level">
        <option value="">Everything</option>${['debug', 'info', 'warn', 'error'].map((l) => `<option value="${l}" ${q.get('level') === l ? 'selected' : ''}>${l} and up</option>`).join('')}</select></label>
      <label class="field"><span>Run</span><input name="run" inputmode="numeric" value="${v('run')}" placeholder="#"></label>
      <label class="field"><span>Chain</span><select name="chain"><option value="">Every chain</option>${chains.map((c) => `<option value="${esc(c.id)}" ${q.get('chain') === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Task</span><input name="task" inputmode="numeric" value="${v('task')}" placeholder="#"></label>
      <label class="field"><span>Step</span><select name="step"><option value="">Every step</option>${STEPS.map((s) => `<option ${q.get('step') === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field" style="grid-column: span 2"><span>Search</span><input name="q" type="search" value="${v('q')}" placeholder="Text in the message or context"></label>
      <button class="primary" type="submit">Filter</button>
    </form>
    <section class="panel" style="margin-top:20px">${logTable(logs, true)}
      ${logs.length === 300 ? `<p style="margin:12px 0 0"><a href="#/logs?${(() => { const p = new URLSearchParams(params); p.set('before', logs[logs.length - 1].id); p.delete('limit'); return p; })()}">Older lines</a></p>` : ''}
    </section>`;
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, val] of new FormData(e.target)) if (val) p.set(k, val);
    location.hash = `#/logs?${p}`;
  };
}

// ─── Trends ─────────────────────────────────────────────────────────────────

function durationChart(runs) {
  const rs = runs.filter((r) => r.duration_ms != null);
  if (!rs.length) return '<p class="empty">No finished runs in this period.</p>';
  const W = 900, H = 200, pad = 28;
  const max = Math.max(...rs.map((r) => r.duration_ms), 1);
  const bw = Math.min(24, Math.max(2, (W - pad) / rs.length - 1));
  const color = { succeeded: 'var(--ok)', partial: 'var(--retry)', failed: 'var(--fail)', cancelled: 'var(--skip)', running: 'var(--run)' };
  const bars = rs.map((r, i) => {
    const h = Math.max(1, (r.duration_ms / max) * (H - pad));
    return `<a href="#/runs/${r.id}"><rect x="${pad + i * (bw + 1)}" y="${H - 14 - h}" width="${bw}" height="${h}" fill="${color[r.status] || 'var(--skip)'}"><title>Run #${r.id}, ${STATUS_LABEL[r.status]}, ${fmtDur(r.duration_ms)}, ${fmtTime(r.created_at)}</title></rect></a>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Duration per run">
    <line class="axis" x1="${pad}" x2="${W}" y1="${H - 14}" y2="${H - 14}"/>
    <text x="0" y="12">${fmtDur(max)}</text><text x="0" y="${H - 16}">0</text>
    ${bars}</svg>`;
}

async function renderTrends(q) {
  const days = Number(q.get('days') || 30);
  const type = q.get('type') || 'deltas';
  const d = await api(`/trends?days=${days}`);
  const daysList = [...new Set(d.chains.map((r) => r.day))].sort();
  const byChain = {};
  for (const r of d.chains) (byChain[r.chain_id] ||= {})[r.day] = r;
  app.innerHTML = `
    <div class="page-head"><h1>Trends</h1>
      <form class="row" id="f">
        <select name="days">${[7, 30, 90].map((x) => `<option value="${x}" ${x === days ? 'selected' : ''}>Last ${x} days</option>`).join('')}</select>
        <select name="type">${['deltas', 'full', 'stores'].map((t) => `<option value="${t}" ${t === type ? 'selected' : ''}>${TYPE_LABEL[t]} runs</option>`).join('')}</select>
      </form></div>
    <div class="stack">
      <section class="panel"><h2>How long each run took</h2>
        <p class="muted small" style="margin:-6px 0 10px">Colored by outcome. Select a bar to open the run.</p>
        ${durationChart(d.runs.filter((r) => r.type === type))}</section>
      <section class="panel"><h2>Failed branches per chain, by day</h2>
        <p class="muted small" style="margin:-6px 0 10px">Darker red means a larger share of that day's branches failed.</p>
        ${daysList.length ? `<div class="heat">${Object.keys(byChain).sort().map((c) => `
          <div class="heat-row"><div>${esc(chains.find((x) => x.id === c)?.name || c)}</div>
            <div class="heat-cells">${daysList.map((day) => {
              const r = byChain[c][day];
              if (!r) return '<i title="no runs"></i>';
              const rate = r.total ? r.failed / r.total : 0;
              const bg = rate === 0 ? 'var(--ok)' : `color-mix(in srgb, var(--fail) ${Math.round(25 + rate * 75)}%, var(--panel))`;
              return `<i style="background:${bg}" title="${day}: ${r.failed} of ${r.total} failed"></i>`;
            }).join('')}</div></div>`).join('')}</div>` : '<p class="empty">No branch history yet.</p>'}
      </section>
      <div class="split" style="grid-template-columns:1fr 1fr">
        <section class="panel"><h2>Chains</h2><table><thead><tr><th>Chain</th><th class="num">Runs</th><th class="num">Failed</th><th class="num">Avg time</th></tr></thead><tbody>
          ${d.chain_jobs.map((c) => `<tr><td>${chainName(c.chain_id)}</td><td class="num">${n(c.total)}</td><td class="num">${n(c.failed)}</td><td class="num">${fmtDur(Math.round(c.avg_duration_ms || 0))}</td></tr>`).join('')}
        </tbody></table></section>
        <section class="panel"><h2>Branches that fail most</h2>
          ${d.top_failures.length ? `<table><tbody>${d.top_failures.map((f) => `<tr><td>${esc(f.chain_id)}/${esc(f.store_code)}<div class="muted small">${esc((f.last_error || '').slice(0, 120))}</div></td><td class="num">${n(f.failures)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No branch failures in this period.</p>'}
        </section>
      </div>
    </div>`;
  document.getElementById('f').onchange = (e) => {
    const f = new FormData(e.currentTarget);
    location.hash = `#/trends?days=${f.get('days')}&type=${f.get('type')}`;
  };
}

// ─── Schedules ──────────────────────────────────────────────────────────────

async function renderSchedules() {
  const list = await api('/schedules');
  app.innerHTML = `
    <div class="page-head"><div><h1>Schedule</h1>
      <p class="muted" style="margin:6px 0 0">Cron patterns in ${esc(tz)} time. Only one run happens at a time: a run that falls due while another is going is recorded as skipped.</p></div></div>
    <section class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Run</th><th>Pattern</th><th>Next</th><th>Last fired</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td><b>${esc(TYPE_LABEL[s.run_type])}</b><div class="muted small">${esc(s.name)}</div></td>
        <td><form class="row" data-cron="${esc(s.name)}"><input name="cron" class="mono" value="${esc(s.cron)}" size="16" aria-label="Cron pattern for ${esc(s.name)}"><button type="submit">Save</button></form></td>
        <td>${s.paused ? '<span class="status s-cancelled">Paused</span>' : `${fmtTime(s.next_at)} <span class="muted small">${fmtRel(s.next_at)}</span>`}</td>
        <td class="small">${fmtTime(s.last_fired_at)}</td>
        <td><button data-pause="${esc(s.name)}" data-paused="${s.paused}">${s.paused ? 'Resume' : 'Pause'}</button></td>
      </tr>`).join('')}</tbody></table></div>
      <p class="muted small" style="margin:12px 0 0">Defaults: branch list <span class="mono">30 2 * * *</span>, full <span class="mono">0 3 * * *</span>, deltas <span class="mono">0 0-2,4-23 * * *</span> (every hour except 03:00).</p>
    </section>`;
  app.querySelectorAll('form[data-cron]').forEach((f) => (f.onsubmit = (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    act(btn, () => api(`/schedules/${f.dataset.cron}`, { method: 'PUT', body: JSON.stringify({ cron: f.cron.value }) }), 'Schedule saved');
  }));
  app.querySelectorAll('[data-pause]').forEach((b) => (b.onclick = () => {
    const paused = b.dataset.paused === '1';
    act(b, () => api(`/schedules/${b.dataset.pause}`, { method: 'PUT', body: JSON.stringify({ paused: !paused }) }), paused ? 'Schedule resumed' : 'Schedule paused');
  }));
}

// ─── Router & live updates ──────────────────────────────────────────────────

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

async function route() {
  const { parts, q } = parseHash();
  const [section, id] = parts;
  const nav = section === 'logs' || section === 'trends' || section === 'schedules' ? section : 'home';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));

  const views = {
    undefined: () => renderHome(),
    runs: () => (id ? renderRun(id) : renderRuns(q)),
    tasks: () => renderTask(id),
    logs: () => renderLogs(q),
    trends: () => renderTrends(q),
    schedules: () => renderSchedules(),
  };
  currentRender = views[section] || (() => { app.innerHTML = '<p class="empty">Page not found. <a href="#/">Back to runs</a></p>'; });
  // Live refreshes only for the views that show moving state.
  currentRender.live = ['undefined', 'runs', 'tasks'].includes(String(section));
  await refresh(true);
}

async function refresh(navigated) {
  const token = ++renderToken;
  const scrollY = window.scrollY;
  const focusId = document.activeElement && document.activeElement.id;
  try {
    await currentRender();
  } catch (err) {
    if (token !== renderToken) return;
    app.innerHTML = `<div class="errorbox"><b>Couldn't load this page</b><p>${esc(err.message)}</p></div>`;
  }
  if (navigated) {
    window.scrollTo(0, 0);
  } else {
    window.scrollTo(0, scrollY);
    if (focusId) document.getElementById(focusId)?.focus();
  }
}

// Avoid replacing the page while someone is typing in a form.
const editing = () => document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
let pendingRefresh = null;
function scheduleRefresh() {
  if (!currentRender || !currentRender.live || pendingRefresh) return;
  pendingRefresh = setTimeout(() => {
    pendingRefresh = null;
    if (editing() || document.hidden) return;
    refresh(false);
  }, 800);
}

function connect() {
  const live = document.getElementById('live');
  const es = new EventSource('/api/events');
  es.onopen = () => { live.textContent = 'live'; live.classList.add('on'); };
  es.addEventListener('change', scheduleRefresh);
  es.onerror = () => { live.textContent = 'reconnecting'; live.classList.remove('on'); };
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => !document.hidden && scheduleRefresh());
// The clock moves even when nothing changes (elapsed times, "in 12 min").
setInterval(scheduleRefresh, 30_000);

(async function init() {
  try {
    const o = await api('/overview');
    tz = o.timezone;
    chains = o.chains;
    renderHealth(o.health);
  } catch { /* the route renders its own error */ }
  connect();
  route();
})();
