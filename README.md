# catalog-api

MongoDB-backed price-comparison catalog, deployed as **Vercel serverless
functions**. This service replaces the Firestore-based price sync that used to
live in `functions/src/priceSync.ts` — it owns both the **write path** (scraping
the Cerberus price-transparency portal → MongoDB) and the **read path** (the
mobile app's catalog queries).

## Why this exists

A single full sync writes ~100k product documents. On Firestore that blew past
the free-tier daily write cap (20k/day). MongoDB Atlas has **no per-write daily
quota**, so a full snapshot writes without hitting a wall — and the app reads
the catalog through this API instead of talking to the database directly.

## Architecture

```
Vercel Cron ──► /api/cron/sync?mode=full|deltas
                     │  (scrape Cerberus → parse XML → upsert)
                     ▼
                MongoDB Atlas  (products, syncState)
                     ▲
   Expo app ──► /api/products/*  (x-api-key)
```

The Firebase Cloud Function no longer runs the sync; it only handles push
notifications now.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/products?chain=&limit=&cursor=` | `x-api-key` | Paginated catalog (keyset). `chain` filters + sorts cheapest-first. |
| `GET /api/products/search?q=&max=` | `x-api-key` | Prefix + keyword search. |
| `GET /api/products/:barcode` | `x-api-key` | Single product. |
| `GET/POST /api/sync/full?chain=` | `x-sync-secret` | Full PriceFull sync (one chain, or all). |
| `GET/POST /api/sync/deltas?chain=` | `x-sync-secret` | Intraday delta sync. |
| `GET /api/cron/sync?mode=full\|deltas` | `CRON_SECRET` (Bearer) | Vercel Cron target; runs all chains. |

## Environment variables

See `.env.example`. Set these in the Vercel project settings:

- `MONGODB_URI`, `MONGODB_DB`
- `CATALOG_API_KEY` — the app sends it in `x-api-key`.
- `SYNC_SECRET` — required to trigger `/api/sync/*`.
- `CRON_SECRET` — Vercel Cron sends it as `Authorization: Bearer …`.

## Deploy

```bash
cd catalog-api
vercel link           # once, creates the Vercel project
vercel env add ...    # add the vars above (or via the dashboard)
vercel --prod
```

Set the Vercel project's **Root Directory** to `catalog-api` so it deploys this
folder on its own.

### First-time backfill

After deploy, populate the catalog (no quota limit to worry about):

```bash
curl -H "x-sync-secret: $SYNC_SECRET" \
  "https://<project>.vercel.app/api/sync/full?chain=osher_ad"
# …repeat per chain, or hit /api/sync/full with no chain for all of them.
```

## Notes & limits

- **Cron schedule is UTC.** `0 1 * * *` ≈ 03:00–04:00 Asia/Jerusalem depending
  on DST. Adjust in `vercel.json` if you need an exact local time.
- **Vercel Hobby caps cron jobs** (limited count, once-per-day granularity). The
  4×/day delta cron and per-hour schedules require the **Pro** plan; on Hobby,
  either keep only the nightly full sync or trigger `/api/sync/*` from an
  external scheduler (GitHub Actions, cron-job.org) with the `SYNC_SECRET`.
- `/api/cron/sync` runs all chains sequentially within one 300s invocation. If a
  chain's file grows large enough to risk that ceiling, switch to per-chain
  crons hitting `/api/sync/{mode}?chain=<id>`.
- MongoDB client connections are cached across warm invocations (`lib/mongo.ts`)
  to stay within the Atlas M0 connection limit.
