import { CHAINS } from '../../lib/chains';
import { gz, harness, priceXml, publishChain, deltaName } from './fakes';
import { Scheduler } from '../src/scheduler';
import { createDashboardServer } from '../src/server';
import { Logger } from '../src/logger';

// ─── Demo ─────────────────────────────────────────────────────────────────────
//
//   npm run demo   → http://localhost:4199
//
// The real engine, scheduler and dashboard over a simulated portal and an
// in-memory catalog, with a few runs (one with failing branches) already in
// the history. Nothing touches the network or a real database. For trying the
// dashboard out; the data resets on every start.

async function main() {
  const chains = CHAINS.map((c) => ({ ...c }));
  const h = harness({ chains, config: { branchConcurrency: 3, maxAttempts: 2, port: 4199 } });
  h.config.publicUrl = 'http://localhost:4199';
  const numbers = ['7290103152017', '7290058140886', '7290803800003', '7290873255550'];
  const files = chains.map((c, i) =>
    publishChain(h, c, numbers[i], Array.from({ length: 6 + i * 8 }, (_, k) => String(k + 1).padStart(3, '0')), 400),
  );
  // A couple of broken branch files, and a portal that times out once.
  h.portal.addFile(chains[1].username, files[1]['004'], Buffer.from('<html>Service unavailable</html>'));
  h.portal.fault(files[2]['002'], { kind: 'transient', times: 1 });

  const engine = h.engine;
  const wait = () => engine.idle();
  engine.startRun({ type: 'stores', trigger: 'schedule', scheduleName: 'stores' });
  await wait();
  engine.startRun({ type: 'full', trigger: 'schedule', scheduleName: 'full' });
  await wait();
  for (let i = 0; i < chains.length; i++) {
    h.portal.addFile(chains[i].username, deltaName(numbers[i], '001', '20261113-100000'), gz(priceXml('001', 30, () => 7)));
  }
  engine.startRun({ type: 'deltas', trigger: 'schedule', scheduleName: 'deltas' });
  await wait();

  // Slow the portal down so a manual run can be watched live.
  const download = h.portal.download.bind(h.portal);
  h.portal.download = async (s, f, sig) => {
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 900));
    return download(s, f, sig);
  };

  const log = new Logger(h.repo, {}, { stdoutLevel: 'warn' });
  const scheduler = new Scheduler(engine, h.repo, h.config.timezone, log);
  const server = createDashboardServer({ engine, repo: h.repo, scheduler, raw: h.raw, config: h.config, log });
  server.listen(4199, '127.0.0.1', () => console.log('demo dashboard: http://localhost:4199'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
