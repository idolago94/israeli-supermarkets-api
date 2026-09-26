import postgres from 'postgres';

// ─── Cached Postgres connection (v2 catalog, Supabase) ───────────────────────
//
// Same reasoning as lib/mongo.ts: serverless invocations are reused across
// requests on a warm instance, so the pooled client is cached on the global
// object instead of reconnecting every call. Point DATABASE_URL at Supabase's
// *pooled* connection string (the "Transaction" pooler, port 6543) — a direct
// connection-per-invocation would exhaust Postgres' connection limit under
// concurrent Vercel invocations the same way an uncached MongoClient would.

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Surfaced at cold start rather than on first query, so a misconfiguration
  // fails loudly in the function logs.
  throw new Error('DATABASE_URL is not set');
}

interface CatalogV2Global {
  _catalogPg?: postgres.Sql;
}

const g = globalThis as unknown as CatalogV2Global;
if (!g._catalogPg) {
  g._catalogPg = postgres(connectionString, {
    // Supabase's pooler already pools connections server-side; keep this
    // instance's own pool small so many concurrent warm invocations don't
    // each hold a large slice of it.
    max: 5,
    idle_timeout: 20,
  });
}

export const sql = g._catalogPg;
