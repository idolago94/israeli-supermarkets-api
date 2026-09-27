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

// A full sync calls this for the same handful of tag names against every
// item in every branch file — for a ~100-branch chain like rami_levy that's
// tens of millions of tagValue() calls per run. The previous version compiled
// a brand-new RegExp on every call; caching one compiled RegExp per tag cuts
// that to a handful of compilations for the whole run instead.
const tagRegexCache = new Map<string, RegExp>();

function tagRegex(tag: string): RegExp {
  let re = tagRegexCache.get(tag);
  if (!re) {
    re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
    tagRegexCache.set(tag, re);
  }
  return re;
}

/** Case-insensitive single-tag lookup inside a block of XML text. */
export function tagValue(block: string, tag: string): string {
  const m = tagRegex(tag).exec(block);
  return m ? decodeEntities(m[1]).trim() : '';
}
