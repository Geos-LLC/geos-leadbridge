/**
 * One-shot migration runner for PR-E (account ↔ service assignments).
 *
 * Prisma's migration engine hangs against the Supavisor pooler in
 * transaction mode (no prepared statement persistence + advisory lock
 * issues). We sidestep it by:
 *   1. Running the ALTER TABLE via raw pg client
 *   2. Inserting a _prisma_migrations row so future `prisma migrate
 *      deploy` runs from Railway don't try to re-apply it
 *
 * The migration itself is a single nullable column add — idempotent
 * via "ADD COLUMN IF NOT EXISTS" and the _prisma_migrations check.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const MIGRATION_NAME = '20260616180000_add_saved_account_service_assignments';
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  MIGRATION_NAME,
  'migration.sql',
);

async function main() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL not set in .env');
  const client = new Client({ connectionString: url });
  await client.connect();
  console.log('Connected via DIRECT_URL (pooler).');

  // Check whether this migration is already recorded.
  const existing = await client.query(
    `SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1`,
    [MIGRATION_NAME],
  );
  if (existing.rows.length > 0 && existing.rows[0].finished_at) {
    console.log('Already applied at', existing.rows[0].finished_at);
    await client.end();
    return;
  }

  // Read the migration SQL.
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  console.log('Applying ALTER TABLE…');
  // ADD COLUMN IF NOT EXISTS to make this idempotent even if a prior
  // run partially succeeded.
  const idempotentSql = sql.replace(
    /ADD COLUMN "serviceProfileAssignmentsJson" TEXT/i,
    'ADD COLUMN IF NOT EXISTS "serviceProfileAssignmentsJson" TEXT',
  );
  await client.query(idempotentSql);
  console.log('ALTER TABLE applied.');

  // Record in _prisma_migrations.
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO _prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
    [id, checksum, MIGRATION_NAME],
  );
  console.log('Recorded in _prisma_migrations.');

  // Verify the column exists.
  const cols = await client.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'saved_accounts'
        AND column_name = 'serviceProfileAssignmentsJson'`,
  );
  console.log('Column verification:', cols.rows);

  await client.end();
  console.log('DONE.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
