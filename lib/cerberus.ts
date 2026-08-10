import { gunzipSync } from 'zlib';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Agent } from 'undici';
import { rootCertificates } from 'tls';

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
});

async function cerberusFetch(url: string, init: Record<string, unknown> = {}): Promise<Response> {
  return fetch(url, { ...init, dispatcher: cerberusDispatcher } as any);
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

export async function cerberusLogin(username: string): Promise<string> {
  const page = await cerberusFetch(`${CERBERUS_BASE}/login`);
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
  });
  return cookiesFrom(res, cookie);
}

/** Lists files whose name contains `search` (case-insensitive substring match server-side). */
export async function cerberusListFiles(cookie: string, search: string): Promise<string[]> {
  const filePage = await cerberusFetch(`${CERBERUS_BASE}/file`, { headers: { cookie } });
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
  });
  if (!res.ok) throw new Error(`file listing failed (${res.status})`);
  const json = (await res.json()) as any;
  const rows: any[] = json?.aaData ?? [];
  return rows.map((r) => (typeof r === 'string' ? r : r?.fname ?? r?.name ?? ''));
}

export function fileTimestamp(name: string): string {
  return /(\d{12})/.exec(name)?.[1] ?? '';
}

export function filterByStore(files: string[], storeId?: string): string[] {
  if (!storeId) return files;
  const filtered = files.filter((f) => f.includes(`-${storeId.padStart(3, '0')}-`));
  return filtered.length ? filtered : files;
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
 * the download (and the parse) when a chain hasn't republished. Returns null if
 * the server doesn't support HEAD here — callers then download unconditionally.
 */
export async function headFileMeta(
  cookie: string,
  fname: string,
): Promise<{ size: string; modified: string } | null> {
  try {
    const res = await cerberusFetch(downloadUrl(fname), { method: 'HEAD', headers: { cookie } });
    if (!res.ok) return null;
    return {
      size: res.headers.get('content-length') ?? '',
      modified: res.headers.get('last-modified') ?? '',
    };
  } catch {
    return null;
  }
}

export async function downloadFile(cookie: string, fname: string): Promise<string> {
  const res = await cerberusFetch(downloadUrl(fname), { headers: { cookie } });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${fname}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const xmlBuf = fname.toLowerCase().endsWith('.gz') ? gunzipSync(buf) : buf;
  return xmlBuf.toString('utf8').replace(/^\uFEFF/, '');
}
