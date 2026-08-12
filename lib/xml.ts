// ─── Minimal shared XML helpers ────────────────────────────────────────────
//
// Cerberus files are flat XML with no same-named tag nested inside itself, so
// a small regex-based reader is enough for both PriceFull/Price items and
// Stores records — no need for a full XML parser dependency.

export function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Case-insensitive single-tag lookup inside a block of XML text. */
export function tagValue(block: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(block);
  return m ? decodeEntities(m[1]).trim() : '';
}
