import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { CerberusHttpError, CerberusSessionExpiredError, ChainConfig, fileTimestamp } from '../../lib/cerberus';
import type { ParsedStore } from '../../lib/stores';
import type { BranchWriteResult, DeltaBranchInput, FullBranchInput } from '../../lib/v2Writer';
import { loadConfig, ServiceConfig } from '../src/config';
import { openDb } from '../src/db';
import { Engine } from '../src/engine';
import { Logger } from '../src/logger';
import type { FileMeta, Portal } from '../src/portal';
import { RawStore } from '../src/rawStore';
import { Repo } from '../src/repo';
import type { StoreState, Target } from '../src/target';

// ─── Test doubles ─────────────────────────────────────────────────────────────
//
// FakePortal stands in for the Cerberus portal (files held in memory, with
// failures injectable per file), FakeTarget for the v2 Postgres catalog
// (per-branch writes recorded in maps, with the same skip/cursor semantics as
// lib/v2Writer.ts).

export function priceXml(storeCode: string, count: number, priceFor: (i: number) => number = (i) => 5 + (i % 50)): string {
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = String(7290000000000 + i);
    items.push(
      `<Item><ItemCode>${code}</ItemCode><ItemName>מוצר ${i}</ItemName><ItemPrice>${priceFor(i).toFixed(2)}</ItemPrice></Item>`,
    );
  }
  return `<?xml version="1.0" encoding="utf-8"?><Root><StoreID>${storeCode}</StoreID><Items>${items.join('')}</Items></Root>`;
}

export function storesXml(codes: string[]): string {
  const stores = codes.map((c) => `<Store><StoreID>${c}</StoreID><StoreName>סניף ${c}</StoreName><City>תל אביב</City></Store>`);
  return `<Root><SubChains><SubChain><SubChainID>001</SubChainID><Stores>${stores.join('')}</Stores></SubChain></SubChains></Root>`;
}

export const gz = (xml: string) => gzipSync(Buffer.from(xml, 'utf8'));

export function fullName(chainNo: string, store: string, ts = '20261113-030000'): string {
  return `PriceFull${chainNo}-001-${store}-${ts}.gz`;
}
export function deltaName(chainNo: string, store: string, ts: string): string {
  return `Price${chainNo}-001-${store}-${ts}.gz`;
}

type Fault =
  | { kind: 'transient'; times: number }
  | { kind: 'session'; times: number }
  | { kind: 'http'; status: number; times: number }
  | { kind: 'hang'; times: number };

export class FakePortal implements Portal {
  /** username -> file name -> body */
  files = new Map<string, Map<string, Buffer>>();
  meta = new Map<string, FileMeta>();
  loginFailures = new Map<string, number>();
  faults = new Map<string, Fault>();
  calls = { login: 0, list: 0, head: 0, download: 0 };
  sessions = new Set<string>();
  private sessionNo = 0;

  addFile(username: string, name: string, body: Buffer, meta?: FileMeta): void {
    if (!this.files.has(username)) this.files.set(username, new Map());
    this.files.get(username)!.set(name, body);
    this.meta.set(name, meta ?? { size: String(body.length), modified: `m-${name}` });
  }

  fault(file: string, fault: Fault): void {
    this.faults.set(file, fault);
  }

  private async maybeFail(file: string, signal: AbortSignal): Promise<void> {
    const f = this.faults.get(file);
    if (!f || f.times <= 0) return;
    f.times--;
    if (f.kind === 'transient') {
      const err: any = new TypeError('fetch failed');
      err.cause = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      throw err;
    }
    if (f.kind === 'session') throw new CerberusSessionExpiredError(`${file} redirected to the login page`);
    if (f.kind === 'http') throw new CerberusHttpError(`download failed (${f.status}) for ${file}`, f.status);
    if (f.kind === 'hang') {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  }

  async login(username: string): Promise<string> {
    this.calls.login++;
    const left = this.loginFailures.get(username) ?? 0;
    if (left > 0) {
      this.loginFailures.set(username, left - 1);
      throw new CerberusHttpError('login failed (403)', 403);
    }
    const cookie = `${username}-session-${++this.sessionNo}`;
    this.sessions.add(cookie);
    return cookie;
  }

  private userOf(session: string): string {
    return session.replace(/-session-\d+$/, '');
  }

  async listFiles(session: string, search: string): Promise<string[]> {
    this.calls.list++;
    const files = [...(this.files.get(this.userOf(session))?.keys() ?? [])];
    return files.filter((f) => f.toLowerCase().includes(search.toLowerCase()));
  }

  async head(session: string, file: string, signal: AbortSignal): Promise<FileMeta> {
    this.calls.head++;
    const meta = this.meta.get(file);
    if (!meta) throw new CerberusHttpError(`HEAD failed (404) for ${file}`, 404);
    return meta;
  }

  async download(session: string, file: string, signal: AbortSignal): Promise<Buffer> {
    this.calls.download++;
    await this.maybeFail(file, signal);
    const body = this.files.get(this.userOf(session))?.get(file);
    if (!body) throw new CerberusHttpError(`download failed (404) for ${file}`, 404);
    return body;
  }
}

interface FakeStore extends StoreState {
  name: string;
  prices: Map<string, number>;
}

export class FakeTarget implements Target {
  chains = new Set<string>();
  /** chain -> store code -> state */
  stores = new Map<string, Map<string, FakeStore>>();
  products = new Map<string, number>();
  fullWrites: FullBranchInput[] = [];
  deltaWrites: DeltaBranchInput[] = [];
  recomputed: number[][] = [];
  writeFailures = new Map<string, { times: number; error: () => Error }>();

  private store(chainId: string, code: string): FakeStore {
    if (!this.stores.has(chainId)) this.stores.set(chainId, new Map());
    const m = this.stores.get(chainId)!;
    if (!m.has(code)) {
      m.set(code, { name: code, prices: new Map(), lastPriceFile: null, lastPriceSize: null, lastPriceModified: null, lastDeltaTs: null });
    }
    return m.get(code)!;
  }

  private productId(barcode: string): number {
    if (!this.products.has(barcode)) this.products.set(barcode, this.products.size + 1);
    return this.products.get(barcode)!;
  }

  private maybeFail(key: string): void {
    const f = this.writeFailures.get(key);
    if (f && f.times > 0) {
      f.times--;
      throw f.error();
    }
  }

  async upsertChain(chain: ChainConfig): Promise<void> {
    this.chains.add(chain.id);
  }
  async writeStores(chainId: string, list: ParsedStore[]): Promise<number> {
    for (const s of list) this.store(chainId, s.storeId).name = s.name;
    return list.length;
  }
  async ensureStores(chainId: string, codes: string[]): Promise<void> {
    for (const c of codes) this.store(chainId, c);
  }
  async loadStoreStates(chainId: string): Promise<Map<string, StoreState>> {
    const out = new Map<string, StoreState>();
    for (const [code, s] of this.stores.get(chainId) ?? []) {
      out.set(code, { lastPriceFile: s.lastPriceFile, lastPriceSize: s.lastPriceSize, lastPriceModified: s.lastPriceModified, lastDeltaTs: s.lastDeltaTs });
    }
    return out;
  }
  async writeBranchFull(input: FullBranchInput): Promise<BranchWriteResult> {
    this.maybeFail(`${input.chainId}/${input.storeCode}`);
    const s = this.store(input.chainId, input.storeCode);
    const prices = new Map<string, number>();
    for (const i of input.items) prices.set(i.code, i.price);
    const deleted = [...s.prices.keys()].filter((k) => !prices.has(k)).length;
    const changes = [...prices].filter(([k, v]) => s.prices.get(k) !== v).length;
    s.prices = prices;
    s.lastPriceFile = input.file;
    s.lastPriceSize = input.size;
    s.lastPriceModified = input.modified;
    const ts = fileTimestamp(input.file);
    if (ts && (!s.lastDeltaTs || s.lastDeltaTs < ts)) s.lastDeltaTs = ts;
    this.fullWrites.push(input);
    return {
      storeId: 1,
      productIds: input.items.map((i) => this.productId(i.code)),
      rowsWritten: prices.size,
      rowsDeleted: deleted,
      priceChanges: changes,
    };
  }
  async writeBranchDelta(input: DeltaBranchInput): Promise<BranchWriteResult> {
    this.maybeFail(`${input.chainId}/${input.storeCode}`);
    const s = this.store(input.chainId, input.storeCode);
    const ts = fileTimestamp(input.file);
    if (!input.force && s.lastDeltaTs && s.lastDeltaTs >= ts) {
      return { storeId: 1, productIds: [], rowsWritten: 0, rowsDeleted: 0, priceChanges: 0, alreadyApplied: true };
    }
    let changes = 0;
    for (const i of input.items) {
      if (s.prices.get(i.code) !== i.price) changes++;
      s.prices.set(i.code, i.price);
    }
    if (!s.lastDeltaTs || s.lastDeltaTs < ts) s.lastDeltaTs = ts;
    this.deltaWrites.push(input);
    return { storeId: 1, productIds: input.items.map((i) => this.productId(i.code)), rowsWritten: input.items.length, rowsDeleted: 0, priceChanges: changes };
  }
  async recomputeNames(ids: number[]): Promise<number> {
    this.recomputed.push(ids);
    return ids.length;
  }
  async close(): Promise<void> {}
}

export const CHAIN_A: ChainConfig = { id: 'chain_a', nameHe: 'רשת א', username: 'userA' };
export const CHAIN_B: ChainConfig = { id: 'chain_b', nameHe: 'רשת ב', username: 'userB' };
export const NO_A = '7290000000011';
export const NO_B = '7290000000022';

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'sync-service-test-'));
  const base = loadConfig({ SYNC_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
  return {
    ...base,
    branchConcurrency: 2,
    maxAttempts: 3,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    breaker: { threshold: 0.5, minSamples: 4 },
    timeoutsMs: Object.fromEntries(Object.entries(base.timeoutsMs).map(([k]) => [k, 2_000])) as ServiceConfig['timeoutsMs'],
    ...overrides,
  };
}

export interface Harness {
  config: ServiceConfig;
  repo: Repo;
  portal: FakePortal;
  target: FakeTarget;
  raw: RawStore;
  engine: Engine;
  finished: number[];
  newEngine(): Engine;
}

export function harness(opts: { chains?: ChainConfig[]; config?: Partial<ServiceConfig> } = {}): Harness {
  const config = testConfig(opts.config);
  const repo = new Repo(openDb(':memory:'));
  const portal = new FakePortal();
  const target = new FakeTarget();
  const raw = new RawStore(config.rawDir);
  const finished: number[] = [];
  const make = () =>
    new Engine({
      repo,
      config,
      portal,
      target,
      raw,
      log: new Logger(repo, {}, { stdoutLevel: 'silent' }),
      chains: opts.chains ?? [CHAIN_A, CHAIN_B],
      onRunFinished: async (run) => {
        finished.push(run.id);
      },
    });
  return { config, repo, portal, target, raw, engine: make(), finished, newEngine: make };
}

/** Publishes `stores` branches for a chain: a Stores file plus one PriceFull
 *  per branch with `items` items. */
export function publishChain(
  h: Harness,
  chain: ChainConfig,
  chainNo: string,
  stores: string[],
  items = 150,
): Record<string, string> {
  h.portal.addFile(chain.username, `Stores${chainNo}-20261113-020000.gz`, gz(storesXml(stores)));
  const files: Record<string, string> = {};
  for (const s of stores) {
    const name = fullName(chainNo, s);
    h.portal.addFile(chain.username, name, gz(priceXml(s, items)));
    files[s] = name;
  }
  return files;
}
