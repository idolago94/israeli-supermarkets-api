# israeli-supermarkets-api

MongoDB-backed price-comparison catalog for Israeli supermarket chains,
deployed as **Vercel serverless functions** and scheduled by **GitHub Actions
cron**. It owns both the **write path** (scraping the Cerberus
price-transparency portal → MongoDB) and the **read path** (the shopping-list
app's catalog queries).

Consumed by the [`marketing-app`](https://github.com/idolago94/marketing-app)
Expo client, which talks to this API over HTTP and never touches the database
directly.

## Why this exists

A single full sync writes ~100k product documents. On Firestore that blew past
the free-tier daily write cap (20k/day). MongoDB Atlas has **no per-write daily
quota**, so a full snapshot writes without hitting a wall — and the app reads
the catalog through this API instead of talking to the database directly.

The service also used to be scheduled from elsewhere: scheduled Firebase Cloud
Functions in the app's repo POSTed to `/api/sync/*` on a cron, which meant the
catalog's schedule lived in another codebase and required a Firebase **Blaze**
plan for Cloud Scheduler. That scheduler now lives here, in
[`.github/workflows/catalog-sync.yml`](.github/workflows/catalog-sync.yml).

## Architecture

```
GitHub Actions cron ──► POST /api/sync/{full|deltas}?chain=…  (x-sync-secret)
                              │  (scrape Cerberus → parse XML → upsert)
                              ▼
                         MongoDB Atlas  (products, syncState)
                              ▲
        Expo app ──► GET /api/products/*  (x-api-key)
```

This service is intentionally focused: the sync worker (scrape → parse →
MongoDB), the read API, a small admin screen for editing product departments,
and its own cron. Push notifications and the rest of the app's backend stay in
Firebase, in the app repo.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/products?chain=&department=&weighted=&limit=&cursor=` | `x-api-key` | Paginated catalog (keyset). `chain` filters + sorts cheapest-first; `department` (or `__none__`) and `weighted` (`0`/`1`) narrow the set. |
| `GET /api/products/search?q=&max=` | `x-api-key` | Prefix + keyword search. |
| `GET /api/products/:barcode` | `x-api-key` | Single product. |
| `PATCH /api/products/:barcode` | `x-api-key` | Update the product's `departments` (`{ "departments": ["...", "..."] }`; empty array clears them). |
| `GET /api/departments` | `x-api-key` | Distinct department names across the catalog (admin dropdown + app grouping). |
| `GET/POST /api/sync/full?chain=&force=` | `x-sync-secret` | Full PriceFull sync (one chain, or all). Triggered by the scheduler workflow. |
| `GET/POST /api/sync/deltas?chain=` | `x-sync-secret` | Intraday delta sync. Triggered by the scheduler workflow. |
| `GET/POST /api/sync/stores?chain=` | `x-sync-secret` | Refreshes the `stores` collection (branches) from each chain's daily Stores file. Not yet on the scheduler. |

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
| `name`, `nameLower` | `ItemName` (canonical) | Canonical display name — the **shortest** of the per-chain names (`prices.<chain>.name`), recomputed on every sync so it's stable regardless of chain sync order (see `pickCanonicalName` in `lib/parse.ts`). |
| `keywords[]` | `ItemName` | Word-prefix search tokens, unioned across chains. |
| `prices.<chain>.name` | `ItemName` | The product name as this chain writes it; feeds the canonical `name`. |
| `brand` | `ManufactureName` | Manufacturer; omitted when "לא ידוע". |
| `unitQty` | `Quantity` + `UnitOfMeasure` | Derived display label ("1.32 ליטר"). |
| `measure.unitQty` | `UnitQty` | The unit the item is priced by. |
| `measure.quantity` | `Quantity` | Numeric size. |
| `measure.unitOfMeasure` | `UnitOfMeasure` | Unit of `quantity`. |
| `measure.qtyInPackage` | `QtyInPackage` | Units per package. |
| `measure.isWeighted` | `bIsWeighted` | Sold by weight (deli/produce). |
| `prices.<chain>.price` | `ItemPrice` | Cheapest shelf price across the chain's branches (see [Branches](#branches--per-branch-prices) below). |
| `prices.<chain>.unitOfMeasurePrice` | `UnitOfMeasurePrice` | Price per unit of measure (₪/ליטר), from the branch that has the cheapest price. |
| `prices.<chain>.allowDiscount` | `AllowDiscount` | Whether the chain allows discounts, from the branch that has the cheapest price. |
| `prices.<chain>.priceVaries` | derived | `true` when the chain's branches don't all sell the item at `price` — i.e. it's the cheapest of several, not a flat chain-wide price. |
| `departments[]` | **manual** | One or more categories, set via the admin screen / PATCH. Not in the source, so the sync never overwrites them — they survive every re-sync. The legacy single `department` field is still read for backward compatibility until a product is re-saved. |

## Branches / per-branch prices

Each chain publishes prices **per physical branch**, not one chain-wide file —
e.g. `rami_levy` alone has ~100 separate branch files. A full sync now
downloads every branch's latest `PriceFull` file (bounded concurrency,
`FULL_SYNC_CONCURRENCY` in `lib/sync.ts`) and merges them per barcode: the
catalog's `prices.<chain>.price` is the **cheapest** of the branches that
carry the item, and `priceVaries` flags items where branches disagree on
price. The chain's branch directory itself (name, address, city) is kept in a
separate `stores` collection, refreshed by `/api/sync/stores` from each
chain's daily Stores file — small and independent of the price fan-out.

**Known limits of this first pass:**
- Only the full sync aggregates across branches. The intraday delta sync
  (`/api/sync/deltas`) still applies whichever branch's delta file happens to
  land, last-file-wins — it doesn't yet re-run the cross-branch min/variance
  logic.
- The "unchanged, skip this sync" check now HEADs every branch file and skips
  only when *all* of them are unchanged; when even one branch republishes, the
  full sync re-downloads and re-parses every branch (no cheaper way to
  recompute cross-branch price differences without caching per-branch data).
- `stores` isn't wired into the scheduler workflow yet — run
  `/api/sync/stores` manually (or add it to `.github/workflows/catalog-sync.yml`)
  after deploying this.

## Environment variables

See [`.env.example`](.env.example). Set these in the Vercel project settings:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Atlas SRV connection string. |
| `MONGODB_DB` | Database name (defaults to `catalog`). |
| `CATALOG_API_KEY` | The app sends it in `x-api-key` on every read. |
| `SYNC_SECRET` | Required to trigger `/api/sync/*`. |

And these as **GitHub Actions repository secrets** (Settings → Secrets and
variables → Actions), for the scheduler:

| Secret | Value |
|---|---|
| `CATALOG_API_BASE` | The deployment's base URL, no trailing slash. |
| `SYNC_SECRET` | Exactly the same value as `SYNC_SECRET` above. |

## Deploy

The repository root *is* the service, so no Root Directory override is needed.

**Via the dashboard (recommended)** — import this repo at
[vercel.com/new](https://vercel.com/new), add the four environment variables
above, and deploy. Every push to `main` then redeploys automatically.

**Via the CLI:**

```bash
vercel link           # once, creates the Vercel project
vercel env add ...    # add the vars above (or via the dashboard)
vercel --prod
```

Full step-by-step setup, including MongoDB Atlas and the app side, is in
[`docs/SETUP.md`](docs/SETUP.md).

### First-time backfill

After deploy, populate the catalog (no quota limit to worry about) — either run
the **catalog sync** workflow from the Actions tab (`mode: full`, `chain: all`),
or by hand:

```bash
curl -X POST -H "x-sync-secret: $SYNC_SECRET" \
  "https://<project>.vercel.app/api/sync/full?chain=osher_ad"
# …repeat per chain, or hit /api/sync/full with no chain for all of them.
```

## Scheduling

The cron lives in this repo:
[`.github/workflows/catalog-sync.yml`](.github/workflows/catalog-sync.yml). It
POSTs to `/api/sync/{mode}` once per chain, sequentially.

| Run | Schedule (Asia/Jerusalem, winter) | Cron (UTC) | Action |
|---|---|---|---|
| Full sync | nightly 03:00 | `0 1 * * *` | `POST /api/sync/full?chain=<id>` |
| Delta syncs | 07:00, 11:00, 15:00, 19:00 | `0 5,9,13,17 * * *` | `POST /api/sync/deltas?chain=<id>` |

GitHub cron only understands UTC, so the times above are Israel **winter** time
(UTC+2); under daylight saving each run lands an hour later locally, which does
not matter for a catalog refresh. Adjust the `cron:` lines to change frequency.

The workflow also has a **manual trigger** (Actions → *catalog sync* → *Run
workflow*) with `mode`, `chain` and `force` inputs — that replaces the old
`syncCatalogNow` HTTP function.

> Why GitHub Actions and not Vercel Cron: Vercel's Hobby plan allows only two
> cron jobs, each at most once a day, which cannot express the four intraday
> delta runs. GitHub's scheduler has no such limit and keeps the schedule next
> to the code it triggers. On a Vercel Pro plan you could instead add a `crons`
> block to `vercel.json` and delete the workflow.
>
> Note that GitHub disables scheduled workflows in repositories with no activity
> for 60 days; re-enable from the Actions tab if that happens.

## Downloading a chain's raw catalog locally

`scripts/download-catalog.ts` bypasses MongoDB entirely: it logs into Cerberus,
grabs the chain's latest `PriceFull` file, and writes both the raw XML and a
parsed JSON to disk. Useful for inspecting a chain's source data without
touching the database — no env vars required.

```bash
npx ts-node scripts/download-catalog.ts <chainId> [outDir]

# e.g.
npx ts-node scripts/download-catalog.ts osher_ad ./out
```

Known `chainId`s: `osher_ad`, `rami_levy`, `yohananof`, `tiv_taam` (see `CHAINS`
in `lib/sync.ts`). `outDir` defaults to the current directory. Output files:

- `<chainId>.PriceFull.xml` — the raw file as published by the chain.
- `<chainId>.catalog.json` — the same data parsed via `lib/parse.ts`
  (`code`, `name`, `price`, `brand`, unit/measure fields, etc.).

The download only covers the chain's default listed branch (no `storeId`
filter) — it fetches whichever single store's `PriceFull` file the portal
lists first for that chain.

## Notes & limits

- A call to `/api/sync/{mode}` with no `chain` runs all chains sequentially
  within one invocation (`maxDuration` 300s), which risks that ceiling as the
  files grow. The scheduler therefore always calls per-chain
  (`/api/sync/{mode}?chain=<id>`), so a failing chain does not take the others
  down with it. `/api/sync/full?chain=<id>` is now itself a fan-out — one
  download + parse per branch of that chain (up to ~100 for `rami_levy`) — so
  it's the one most exposed to the 300s ceiling; `/api/sync/deltas` and
  `/api/sync/stores` stay cheap (one small file per chain).
- MongoDB client connections are cached across warm invocations (`lib/mongo.ts`)
  to stay within the Atlas M0 connection limit.
