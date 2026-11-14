import {
  cerberusHead,
  cerberusListFiles,
  cerberusLogin,
  downloadFileRaw,
} from '../../lib/cerberus';

// ─── Price portal ──────────────────────────────────────────────────────────────
//
// What the engine needs from the Cerberus portal, as an interface so tests can
// swap in a fake portal (tests/fakes.ts) without touching the network. The
// real implementation is a thin wrapper over lib/cerberus.ts. Every call takes
// an AbortSignal, which is how per-step timeouts stop a hung request.

export interface FileMeta {
  size: string;
  modified: string;
}

export interface Portal {
  /** Returns the session cookie. */
  login(username: string, signal: AbortSignal): Promise<string>;
  listFiles(session: string, search: string, signal: AbortSignal): Promise<string[]>;
  head(session: string, file: string, signal: AbortSignal): Promise<FileMeta>;
  /** The file's body exactly as served (still compressed). */
  download(session: string, file: string, signal: AbortSignal): Promise<Buffer>;
}

export const cerberusPortal: Portal = {
  login: (username, signal) => cerberusLogin(username, { signal }),
  listFiles: (session, search, signal) => cerberusListFiles(session, search, { signal }),
  head: (session, file, signal) => cerberusHead(session, file, { signal }),
  download: (session, file, signal) => downloadFileRaw(session, file, { signal }),
};
