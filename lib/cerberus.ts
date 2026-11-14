import { gunzipSync, inflateRawSync } from 'zlib';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Agent } from 'undici';
import { rootCertificates } from 'tls';
import { tagStage } from './syncFailures';

// ─── Cerberus portal client ───────────────────────────────────────────────────
//
// Israeli supermarket chains publish their daily price-transparency files on
// the Cerberus portal (url.publishedprices.co.il) with a public per-chain
// username and an empty password. Ported unchanged from the original Cloud
// Function. Node 20 (Vercel runtime) ships a global fetch.

export const CERBERUS_BASE = 'https://url.publishedprices.co.il';

// The portal's TLS handshake omits its Sectigo intermediate certificate.
// Browsers paper over this via cached/AIA-fetched intermediates; Node's
// strict verifier doesn't, so plain fetch() fails with "unable to verify
// the first certificate". Supplying the intermediate alongside Node's
// normal root store fixes verification without weakening it.
const missingIntermediate = readFileSync(
  join(__dirname, 'certs/sectigo-public-server-auth-ca-dv-r36.pem'),
  'utf8',
);
const cerberusDispatcher = new Agent({
  connect: { ca: [...rootCertificates, missingIntermediate] },
  // The portal occasionally accepts a connection and then never sends a
  // response (seen as undici's default 300s headersTimeout expiring) —
  // fail fast instead of hanging a full sync for 5 minutes per stalled
  // request. bodyTimeout is separate since a full PriceFull download can
  // legitimately take longer than the time-to-first-byte.
  headersTimeout: 20_000,
  bodyTimeout: 60_000,
});

const CERBERUS_FETCH_RETRIES = 2;

/** Optional per-call settings. `signal` aborts the request (and any pending
 *  internal retry) — the local sync service uses it for per-step timeouts. */
export interface CerberusCallOptions {
  signal?: AbortSignal;
}

/** A non-2xx response from the portal. `status` lets callers tell a
 *  transient 5xx/429 from a permanent 4xx. */
export class CerberusHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CerberusHttpError';
  }
}

/** The portal bounced a request back to its login page: the session cookie
 *  expired (or was never accepted). Logging in again and retrying fixes it. */
export class CerberusSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CerberusSessionExpiredError';
  }
}

async function cerberusFetch(
  url: string,
  init: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fetch(url, { ...init, ...(signal ? { signal } : {}), dispatcher: cerberusDispatcher } as any);
    } catch (err) {
      if (signal?.aborted || attempt >= CERBERUS_FETCH_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** True when a (redirect-followed) response landed on the login page. */
function isLoginRedirect(res: Response): boolean {
  try {
    return /^\/login(\/|$)/.test(new URL(res.url).pathname);
  } catch {
    return false;
  }
}

export interface ChainConfig {
  /** Key used in products.prices — keep stable, it's referenced by the app. */
  id: string;
  nameHe: string;
  /** Cerberus login username (published by the Ministry of Economy). */
  username: string;
  /** Optional branch filter, matched against the "-NNN-" part of file names. */
  storeId?: string;
}

function cookiesFrom(res: Response, fallback = ''): string {
  const raw: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];
  const pairs = raw.map((c) => c.split(';')[0]).filter(Boolean);
  return pairs.length ? pairs.join('; ') : fallback;
}

function extractCsrf(html: string): string {
  const meta = /name=["']csrftoken["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (meta) return meta[1];
  const input = /<input[^>]*name=["']csrftoken["'][^>]*value=["']([^"']+)["']/i.exec(html);
  return input ? input[1] : '';
}

export async function cerberusLogin(username: string, opts: CerberusCallOptions = {}): Promise<string> {
  const page = await cerberusFetch(`${CERBERUS_BASE}/login`, {}, opts.signal);
  const cookie = cookiesFrom(page);
  const csrf = extractCsrf(await page.text());

  const res = await cerberusFetch(`${CERBERUS_BASE}/login/user`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
    },
    body: new URLSearchParams({
      r: '',
      username,
      password: '',
      Submit: 'Sign in',
      ...(csrf ? { csrftoken: csrf } : {}),
    }).toString(),
  }, opts.signal);
  return cookiesFrom(res, cookie);
}

/** Lists files whose name contains `search` (case-insensitive substring match server-side). */
export async function cerberusListFiles(
  cookie: string,
  search: string,
  opts: CerberusCallOptions = {},
): Promise<string[]> {
  const filePage = await cerberusFetch(`${CERBERUS_BASE}/file`, { headers: { cookie } }, opts.signal);
  if (isLoginRedirect(filePage)) throw new CerberusSessionExpiredError('file listing redirected to the login page');
  const csrf = extractCsrf(await filePage.text());

  const res = await cerberusFetch(`${CERBERUS_BASE}/file/json/dir`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
    },
    body: new URLSearchParams({
      sEcho: '1',
      iColumns: '1',
      iDisplayStart: '0',
      iDisplayLength: '100000',
      sSearch: search,
      cd: '/',
      ...(csrf ? { csrftoken: csrf } : {}),
    }).toString(),
  }, opts.signal);
  if (isLoginRedirect(res)) throw new CerberusSessionExpiredError('file listing redirected to the login page');
  if (!res.ok) throw new CerberusHttpError(`file listing failed (${res.status})`, res.status);
  const json = (await res.json()) as any;
  const rows: any[] = json?.aaData ?? [];
  return rows.map((r) => (typeof r === 'string' ? r : r?.fname ?? r?.name ?? ''));
}

/**
 * The publish time in a file name, as a sortable 14-digit "YYYYMMDDHHMMSS".
 * The portal uses two layouts:
 *   current: "Price7290058140886-001-039-20261011-070012.gz" (date-time, dashed)
 *   legacy:  "price7290058140886-039-202607151000.gz"        (12 digits, no seconds)
 * Only digit runs that start right after a '-' are considered, so the 13-digit
 * chain id at the front of every name can never be mistaken for a timestamp
 * (which an unanchored /\d{12}/ did — it returned the chain id's first 12
 * digits for every file, so no file ever compared newer than another).
 * Returns '' when the name carries no timestamp.
 */
export function fileTimestamp(name: string): string {
  const current = /-(\d{8})-?(\d{6})(?!\d)/.exec(name);
  if (current) return current[1] + current[2];
  const legacy = /-(\d{12})(?!\d)/.exec(name);
  return legacy ? `${legacy[1]}00` : '';
}

/** True for a value fileTimestamp() can produce — used to discard delta
 *  cursors persisted by the old chain-id-as-timestamp parser. */
export function isFileTimestamp(value: string | undefined): value is string {
  return !!value && /^20\d{12}$/.test(value);
}

export function filterByStore(files: string[], storeId?: string): string[] {
  if (!storeId) return files;
  const filtered = files.filter((f) => f.includes(`-${storeId.padStart(3, '0')}-`));
  return filtered.length ? filtered : files;
}

/**
 * Extracts the per-branch store id from a PriceFull/Price file name, e.g.
 * "PriceFull7290103152017-001-010-20260812-080004.gz" -> "010". Every chain
 * observed so far publishes one such file per branch. The sub-chain segment is
 * optional: rami_levy's legacy files ("price7290058140886-039-202607151000.gz")
 * carry only the store. Returns null for a name with no store segment.
 */
export function storeIdFromFileName(name: string): string | null {
  return /^\D+\d+-(?:\d{3}-)?(\d{3})-\d/.exec(name)?.[1] ?? null;
}

export function pickLatestFile(files: string[], storeId?: string): string | null {
  const pool = filterByStore(files, storeId);
  return (
    [...pool].sort((a, b) => fileTimestamp(b).localeCompare(fileTimestamp(a)))[0] ?? null
  );
}

function downloadUrl(fname: string): string {
  return `${CERBERUS_BASE}/file/d/${encodeURIComponent(fname)}`;
}

/**
 * Cheap change-detection: a HEAD request returns Content-Length and
 * Last-Modified without transferring the file body, letting the full sync skip
 * the download (and the parse) when a chain hasn't republished. Throws on a
 * network error, an HTTP error or an expired session — see headFileMeta for
 * the forgiving variant.
 */
export async function cerberusHead(
  cookie: string,
  fname: string,
  opts: CerberusCallOptions = {},
): Promise<{ size: string; modified: string }> {
  const res = await cerberusFetch(downloadUrl(fname), { method: 'HEAD', headers: { cookie } }, opts.signal);
  if (isLoginRedirect(res)) throw new CerberusSessionExpiredError(`HEAD ${fname} redirected to the login page`);
  if (!res.ok) throw new CerberusHttpError(`HEAD failed (${res.status}) for ${fname}`, res.status);
  return {
    size: res.headers.get('content-length') ?? '',
    modified: res.headers.get('last-modified') ?? '',
  };
}

/** cerberusHead, but returns null on any failure (the server doesn't support
 *  HEAD here, a network blip) — callers then download unconditionally. */
export async function headFileMeta(
  cookie: string,
  fname: string,
): Promise<{ size: string; modified: string } | null> {
  try {
    return await cerberusHead(cookie, fname);
  } catch {
    return null;
  }
}

/**
 * Decode a decompressed file body to text. PriceFull/Price files are UTF-8,
 * but the Stores file is published UTF-16LE (with BOM) by every chain seen so
 * far \u2014 sniff the BOM instead of hardcoding one encoding per file type.
 */
export function decodeXmlBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.subarray(2).swap16().toString('utf16le');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR = 0x06054b50;

/**
 * Extracts the first file from a ZIP archive. Some chains publish files named
 * ".gz" whose body is really a ZIP holding a single XML (rami_levy's legacy
 * "price…-039-…" files, body starting "PK\x03\x04"). Handles the stored and
 * deflate methods those use, reading sizes from the central directory so a
 * local header with a trailing data descriptor (sizes zeroed) works too. No
 * ZIP64 — every source file is a few MB at most.
 */
export function unzipFirstEntry(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === ZIP_END_OF_CENTRAL_DIR) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');

  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== ZIP_CENTRAL_HEADER) throw new Error('zip: corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry

    if (buf.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) throw new Error('zip: corrupt local header');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(start, start + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`zip: unsupported compression method ${method} for ${name}`);
  }
  throw new Error('zip: archive has no file entries');
}

/**
 * Decompresses a downloaded file body by sniffing its magic bytes rather than
 * trusting the extension — the portal serves both gzip and ZIP bodies under
 * ".gz". Anything else under a compressed extension is a portal error page or
 * a truncated transfer, reported with the file name and a body preview.
 */
export function decompressFileBody(buf: Buffer, fname: string): Buffer {
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_HEADER;
  const compressedName = /\.(gz|zip)$/i.test(fname);
  if (!isGzip && !isZip && !compressedName) return buf;

  try {
    if (isZip) return unzipFirstEntry(buf);
    return gunzipSync(buf);
  } catch (err) {
    // A 200 response whose body isn't actually an archive (portal error/rate-
    // limit page served with the expected content-type, a truncated transfer)
    // — cut the opaque zlib error down to something that names the offending
    // file and shows enough of the body to tell the two apart from the logs.
    const kind = isZip ? 'zip' : 'gzip';
    const preview = buf.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
    throw tagStage(
      new Error(`invalid ${kind} for ${fname} (${buf.length} bytes): ${err}; body starts: ${preview}`),
      'decompress',
    );
  }
}

/**
 * Downloads a file's raw body exactly as served (still compressed) — the local
 * sync service keeps this on disk so a failure can be replayed from the same
 * bytes. Tagged 'download' on failure.
 */
export async function downloadFileRaw(
  cookie: string,
  fname: string,
  opts: CerberusCallOptions = {},
): Promise<Buffer> {
  try {
    const res = await cerberusFetch(downloadUrl(fname), { headers: { cookie } }, opts.signal);
    if (isLoginRedirect(res)) throw new CerberusSessionExpiredError(`download of ${fname} redirected to the login page`);
    if (!res.ok) throw new CerberusHttpError(`download failed (${res.status}) for ${fname}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw tagStage(err, 'download');
  }
}

export async function downloadFile(cookie: string, fname: string): Promise<string> {
  const buf = await downloadFileRaw(cookie, fname);
  return decodeXmlBuffer(decompressFileBody(buf, fname));
}
