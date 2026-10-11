import { deflateRawSync } from 'zlib';

/** Builds a single-entry ZIP the way the portal's legacy files are laid out.
 *  `dataDescriptor` zeroes the sizes in the local header (general-purpose
 *  bit 3), so only the central directory carries them. CRCs are left 0 — the
 *  reader doesn't check them. */
export function makeZip(name: string, content: Buffer, opts: { method?: 0 | 8; dataDescriptor?: boolean } = {}): Buffer {
  const method = opts.method ?? 8;
  const data = method === 8 ? deflateRawSync(content) : content;
  const nameBuf = Buffer.from(name, 'utf8');
  const flags = opts.dataDescriptor ? 0x0008 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(opts.dataDescriptor ? 0 : data.length, 18);
  local.writeUInt32LE(opts.dataDescriptor ? 0 : content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const descriptor = opts.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (opts.dataDescriptor) {
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(content.length, 12);
  }
  const localPart = Buffer.concat([local, nameBuf, data, descriptor]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

export const PRICE_XML = `<?xml version="1.0" encoding="utf-8"?>
<Root><ChainID>7290058140886</ChainID><SubChainID>001</SubChainID><StoreID>001</StoreID><Items>
<Item><ItemCode>7290000000001</ItemCode><ItemName>חלב</ItemName><ItemPrice>6.90</ItemPrice></Item>
<Item><ItemCode>7290000000002</ItemCode><ItemName>לחם</ItemName><ItemPrice>9.50</ItemPrice></Item>
</Items></Root>`;

/** In-memory stand-in for the GitHub issues REST API, injected as fetchImpl. */
export class FakeGitHub {
  issues: { number: number; title: string; body: string; labels: string[]; html_url: string; state: string }[] = [];
  comments: { issue: number; body: string }[] = [];
  labels: string[] = [];
  calls: { method: string; path: string }[] = [];
  /** Make every request whose "METHOD path" matches fail with this status. */
  failOn?: { pattern: RegExp; status: number };
  /** Throw (network error) instead of responding. */
  throwOn?: RegExp;

  fetch = (async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https:\/\/api\.github\.com/, '');
    this.calls.push({ method, path });
    const key = `${method} ${path}`;
    if (this.throwOn?.test(key)) throw new TypeError('fetch failed');
    if (this.failOn?.pattern.test(key)) return json({ message: 'Bad credentials' }, this.failOn.status);

    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/repos\/[^/]+\/[^/]+\/issues\?(.*)$/.exec(path))) {
      const q = new URLSearchParams(m[1]);
      return json(this.issues.filter((i) => i.state === 'open' && i.labels.includes(q.get('labels') ?? '')));
    }
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
      const { name } = JSON.parse(init.body);
      if (this.labels.includes(name)) return json({ message: 'Validation Failed' }, 422);
      this.labels.push(name);
      return json({ name }, 201);
    }
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
      const b = JSON.parse(init.body);
      const issue = {
        number: this.issues.length + 1,
        title: b.title,
        body: b.body,
        labels: b.labels ?? [],
        html_url: `https://github.com/o/r/issues/${this.issues.length + 1}`,
        state: 'open',
      };
      this.issues.push(issue);
      return json(issue, 201);
    }
    if (method === 'POST' && (m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path))) {
      this.comments.push({ issue: Number(m[1]), body: JSON.parse(init.body).body });
      return json({ id: this.comments.length }, 201);
    }
    return json({ message: 'Not Found' }, 404);
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Minimal VercelRequest/VercelResponse doubles for the sync endpoints. */
export function fakeReqRes(query: Record<string, string>, headers: Record<string, string> = {}) {
  const req: any = { method: 'POST', url: `/api/sync/x?${new URLSearchParams(query)}`, query, headers: { 'x-sync-secret': 'secret', ...headers } };
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
}
