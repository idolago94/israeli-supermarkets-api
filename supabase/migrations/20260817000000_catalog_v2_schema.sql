-- ─── Catalog v2 schema ────────────────────────────────────────────────────────
--
-- Relational replacement for the v1 MongoDB catalog. Each chain publishes
-- prices per physical branch (see README "Branches / per-branch prices"); v1
-- had to flatten that into one aggregate price per chain per product, which
-- made "cheapest across branches" a write-time computation prone to staleness.
-- Here every (product, store) price is its own row, so "cheapest" is just
-- MIN(price), always correct, and a branch that didn't change never needs to
-- be re-synced to keep that correct.

create table if not exists chains (
  -- Slug id (e.g. "osher_ad") — kept stable because it's also the external
  -- chainId the mobile app already reads from the v1 API.
  id text primary key,
  name_he text not null,
  -- Cerberus portal login username (public, published by the Ministry of Economy).
  username text not null,
  -- Optional: restrict this chain to a single branch (rarely used; mirrors v1's
  -- ChainConfig.storeId escape hatch).
  store_id_override text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stores (
  -- integer (not bigint): postgres.js returns bigint columns as strings to
  -- avoid JS precision loss, which would force string-keyed maps throughout
  -- the sync code for no benefit — a catalog is nowhere near int4's ~2.1B rows.
  id integer generated always as identity primary key,
  chain_id text not null references chains (id) on delete cascade,
  -- Raw StoreID from the chain's Stores/PriceFull files (e.g. "010") — unique
  -- only within a chain, not globally, hence the composite unique constraint.
  store_code text not null,
  sub_chain_id text,
  name text not null,
  address text,
  city text,
  zip_code text,
  store_type text,
  -- Change-detection proxy for this store's latest PriceFull file: a HEAD
  -- request's Content-Length/Last-Modified, not a content hash — this lets a
  -- full sync skip a store without downloading anything, which a real hash
  -- (computed after download) couldn't do. See README "Branches" for why.
  last_price_file text,
  last_price_size text,
  last_price_modified text,
  updated_at timestamptz not null default now(),
  unique (chain_id, store_code)
);

create index if not exists stores_chain_id_idx on stores (chain_id);

create table if not exists products (
  id integer generated always as identity primary key,
  -- Normalized barcode (digits only, no leading zeros) — see normalizeBarcode
  -- in lib/parse.ts. Global across chains: the same physical product.
  barcode text not null unique,
  -- Canonical display name: the shortest of every store's own item name for
  -- this barcode (see pickCanonicalName in lib/parse.ts), recomputed whenever
  -- any of its price rows change so it's stable regardless of sync order.
  name text not null,
  name_lower text not null,
  brand text,
  unit_qty text,
  measure_unit_qty text,
  measure_quantity numeric,
  measure_unit_of_measure text,
  measure_qty_in_package text,
  measure_is_weighted boolean,
  -- Word-prefix search tokens, unioned across every store's name for this
  -- product (lib/parse.ts generateKeywords) — same recall as v1.
  keywords text[] not null default '{}',
  -- Manually-assigned categories (admin screen). Sync never writes this column,
  -- so it survives every re-sync, same guarantee as v1.
  departments text[],
  updated_at timestamptz not null default now()
);

create index if not exists products_name_lower_idx on products (name_lower);
create index if not exists products_keywords_idx on products using gin (keywords);
create index if not exists products_departments_idx on products using gin (departments);

create table if not exists prices (
  product_id integer not null references products (id) on delete cascade,
  store_id integer not null references stores (id) on delete cascade,
  -- This store's own ItemName — kept per-row (not just on products) because
  -- it's what canonical-name selection and keyword generation are computed
  -- from, and it can genuinely differ from what other stores call the same
  -- barcode.
  item_name text not null,
  price numeric not null,
  unit_of_measure_price numeric,
  allow_discount boolean,
  updated_at timestamptz not null default now(),
  primary key (product_id, store_id)
);

-- Cheapest-per-product lookups (MIN(price) grouped by product, optionally
-- joined to stores for a chain filter).
create index if not exists prices_product_price_idx on prices (product_id, price);
create index if not exists prices_store_id_idx on prices (store_id);
