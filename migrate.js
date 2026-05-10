#!/usr/bin/env node
/**
 * Plain-JS migration runner для production (Docker standalone build).
 * lib/database/migrate.ts требует tsx, которого нет в standalone bundle.
 *
 * Применяется при старте через start.js — non-blocking:
 * если не получилось — логируем и стартуем приложение.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

function isNonTransactional(sql) {
  return (
    /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql) ||
    /REINDEX\s+.*CONCURRENTLY/i.test(sql) ||
    /DROP\s+INDEX\s+CONCURRENTLY/i.test(sql)
  );
}

function isAlreadyExistsError(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('already exists') ||
    m.includes('duplicate key') ||
    m.includes('duplicate column') ||
    m.includes('already have')
  );
}

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn('[migrate] DATABASE_URL not set, skipping');
    return;
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn('[migrate] migrations dir not found, skipping');
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' || databaseUrl.includes('sslmode=')
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 10_000,
  });

  let applied = 0, skipped = 0, errors = 0;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const appliedRows = await pool.query('SELECT name FROM _migrations');
    const appliedSet = new Set(appliedRows.rows.map(r => r.name));

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`[migrate] ${files.length} files, ${appliedSet.size} already applied`);

    for (const file of files) {
      if (appliedSet.has(file)) { skipped++; continue; }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      if (!sql.trim()) {
        await pool.query('INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
        skipped++;
        continue;
      }

      try {
        if (isNonTransactional(sql)) {
          const stmts = sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s && !s.startsWith('--'));
          for (const stmt of stmts) {
            try { await pool.query(stmt); }
            catch (e) { if (!isAlreadyExistsError(e.message)) throw e; }
          }
        } else {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
            if (!isAlreadyExistsError(e.message)) throw e;
          } finally {
            client.release();
          }
        }
        await pool.query('INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
        applied++;
        console.log(`[migrate] applied ${file}`);
      } catch (e) {
        errors++;
        console.error(`[migrate] ERROR ${file}: ${e.message}`);
      }
    }

    console.log(`[migrate] done — applied:${applied} skipped:${skipped} errors:${errors}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations().catch(e => { console.error('[migrate] FATAL', e.message); process.exit(0); });
}

module.exports = { runMigrations };
