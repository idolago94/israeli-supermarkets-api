import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { SERVICE_ROOT, loadEnvFile } from './config';

// ─── npm run migrate ───────────────────────────────────────────────────────────
//
// Applies every catalog v2 migration (supabase/migrations/*.sql, in name order)
// to SYNC_DATABASE_URL. Each file is written to be re-runnable ("if not
// exists"), so running this on a database that already has some or all of
// them is safe. No psql needed.

const MIGRATIONS_DIR = join(SERVICE_ROOT, '..', 'supabase', 'migrations');

async function main(): Promise<void> {
  loadEnvFile(join(SERVICE_ROOT, '.env'));
  const url = process.env.SYNC_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('SYNC_DATABASE_URL is not set (sync-service/.env). See SETUP.md, step 3.');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 30 });
  try {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      console.log(`applied ${file}`);
    }
    console.log(`done: ${files.length} migration(s) applied`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`migration failed: ${err?.message ?? err}`);
  process.exit(1);
});
