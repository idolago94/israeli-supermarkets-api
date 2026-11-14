import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

// ─── Raw file store ────────────────────────────────────────────────────────────
//
// Every downloaded file is kept on disk exactly as served (the portal serves
// them gzip/zip-compressed, so they're stored compressed as-is), under
//   <rawDir>/<YYYY-MM-DD>/run-<id>/<chain>/<file>
// so a failure can be reproduced from the same bytes ("replay from file").
// The day folder makes retention a matter of deleting old folders.

export class RawStore {
  constructor(readonly root: string) {}

  save(runId: number, chainId: string, file: string, body: Buffer, now: number): string {
    const day = new Date(now).toISOString().slice(0, 10);
    const dir = join(this.root, day, `run-${runId}`, safe(chainId));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safe(file));
    writeFileSync(path, body);
    return relative(this.root, path);
  }

  read(relPath: string): Buffer {
    return readFileSync(this.resolve(relPath));
  }

  exists(relPath: string): boolean {
    return existsSync(this.resolve(relPath));
  }

  /** Absolute path, refusing anything that escapes the store. */
  resolve(relPath: string): string {
    const abs = resolve(this.root, relPath);
    if (!abs.startsWith(resolve(this.root) + '/') && abs !== resolve(this.root)) {
      throw new Error(`raw file path escapes the store: ${relPath}`);
    }
    return abs;
  }

  /** Deletes day folders older than `cutoff` (epoch ms). Returns how many. */
  deleteDaysBefore(cutoff: number): number {
    if (!existsSync(this.root)) return 0;
    const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
    let removed = 0;
    for (const name of readdirSync(this.root)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= cutoffDay) continue;
      const path = join(this.root, name);
      if (!statSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}

function safe(name: string): string {
  return name.replace(/[^\w.\-]/g, '_');
}
