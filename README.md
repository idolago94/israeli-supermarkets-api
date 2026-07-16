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
Firebase (scheduled) ──► POST /api/sync/{full|deltas}   (x-sync-secret)
                              │  (scrape Cerberus → parse XML → upsert)
                              ▼
                         MongoDB Atlas  (products, syncState)
                              ▲
        Expo app ──► GET /api/products/*  (x-api-key)
```

This service is intentionally focused: the sync worker (scrape → parse →
MongoDB), the read API, and a small admin screen for editing product
departments. It has **no scheduler of its own** — the scheduled **Firebase
functions** (`functions/src/catalogSync.ts`) call the `/api/sync/*` endpoints on
a cron. Push notifications also stay in Firebase.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/products?chain=&department=&weighted=&limit=&cursor=` | `x-api-key` | Paginated catalog (keyset). `chain` filters + sorts cheapest-first; `department` (or `__none__`) and `weighted` (`0`/`1`) narrow the set. |
| `GET /api/products/search?q=&max=` | `x-api-key` | Prefix + keyword search. |
| `GET /api/products/:barcode` | `x-api-key` | Single product. |
| `PATCH /api/products/:barcode` | `x-api-key` | Update the product's `departments` (`{ "departments": ["...", "..."] }`; empty array clears them). |
| `GET /api/departments` | `x-api-key` | Distinct department names across the catalog (admin dropdown + app grouping). |
| `GET/POST /api/sync/full?chain=` | `x-sync-secret` | Full PriceFull sync (one chain, or all). Triggered by Firebase. |
| `GET/POST /api/sync/deltas?chain=` | `x-sync-secret` | Intraday delta sync. Triggered by Firebase. |

Static page: **`/admin.html`** — an RTL admin screen (in `public/`) that lists
every product with all of its info, lets you assign each product to **multiple
departments** (pick from existing ones or add a new one) inline, and filter the
catalog by department / chain (סופר) / weighted (שקיל). It calls the read/PATCH
endpoints above with an `x-api-key` you paste in (stored in `localStorage`).

## Product fields

Each product document carries everything the parser extracts from the Cerberus
`Item`, plus manually-assigned departments:

| Field | Source | Notes |
|---|---|---|
| `name`, `nameLower`, `keywords[]` | `ItemName` | Name + search tokens. |
| `brand` | `ManufactureName` | Manufacturer; omitted when "לא ידוע". |
| `unitQty` | `Quantity` + `UnitOfMeasure` | Derived display label ("1.32 ליטר"). |
| `measure.unitQty` | `UnitQty` | The unit the item is priced by. |
| `measure.quantity` | `Quantity` | Numeric size. |
| `measure.unitOfMeasure` | `UnitOfMeasure` | Unit of `quantity`. |
| `measure.qtyInPackage` | `QtyInPackage` | Units per package. |
| `measure.isWeighted` | `bIsWeighted` | Sold by weight (deli/produce). |
| `prices.<chain>.price` | `ItemPrice` | Shelf price, per chain. |
| `prices.<chain>.unitOfMeasurePrice` | `UnitOfMeasurePrice` | Price per unit of measure (₪/ליטר). |
| `prices.<chain>.allowDiscount` | `AllowDiscount` | Whether the chain allows discounts. |
| `departments[]` | **manual** | One or more categories, set via the admin screen / PATCH. Not in the source, so the sync never overwrites them — they survive every re-sync. The legacy single `department` field is still read for backward compatibility until a product is re-saved. |

## Environment variables

See `.env.example`. Set these in the Vercel project settings:

- `MONGODB_URI`, `MONGODB_DB`
- `CATALOG_API_KEY` — the app sends it in `x-api-key`.
- `SYNC_SECRET` — required to trigger `/api/sync/*`. The Firebase scheduler must
  use the same value (as `CATALOG_SYNC_SECRET`).

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

## Scheduling

There is no cron in this service. The nightly full sync and the intraday delta
syncs are driven by the Firebase functions `syncCatalogFull` / `syncCatalogDeltas`
(`functions/src/catalogSync.ts`), which POST to `/api/sync/{mode}` with the
`x-sync-secret` header. This avoids Vercel Hobby's cron limits and keeps the
schedule alongside the app's other Cloud Functions. See
[`docs/CATALOG_SETUP.md`](../docs/CATALOG_SETUP.md) for the full wiring.

## Notes & limits

- A call to `/api/sync/{mode}` with no `chain` runs all chains sequentially
  within one invocation (`maxDuration` 300s). If a chain's file grows large
  enough to risk that ceiling, have the scheduler call per-chain instead
  (`/api/sync/{mode}?chain=<id>`).
- MongoDB client connections are cached across warm invocations (`lib/mongo.ts`)
  to stay within the Atlas M0 connection limit.
