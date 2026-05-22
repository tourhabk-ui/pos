#!/usr/bin/env node
/**
 * Standalone migration runner (pure CJS, no TypeScript needed).
 * Runs in the Docker runner stage where tsx is unavailable.
 * Uses pg from .next/standalone/node_modules or local node_modules.
 *
 * Called by start.js before spawning Next.js server.
 */

const { readdir, readFile } = require('fs/promises');
const { join, resolve } = require('path');

const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

function isNonTransactional(sql) {
  return /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql)
    || /REINDEX\s+.*CONCURRENTLY/i.test(sql)
    || /DROP\s+INDEX\s+CONCURRENTLY/i.test(sql);
}

function isAlreadyExistsError(msg) {
  const l = msg.toLowerCase();
  return l.includes('already exists')
    || l.includes('duplicate key')
    || l.includes('duplicate column')
    || l.includes('already have');
}

// Parse a postgres URL robustly — handles passwords with special chars (#, ?, @, =, >)
// that confuse WHATWG URL / pg's built-in connection-string parser.
function parseDbUrl(rawUrl) {
  const trimmed = rawUrl.trim().replace(/^['"]+|['"]+$/g, '');
  // Regex: tolerates any characters in the password (greedy, backtracked by regex engine).
  const m = trimmed.match(
    /^(postgres(?:ql)?:\/\/)([^:/?#]+):(.+)@([^:/?#@]+):(\d+)\/([^?#\s]+)/i
  );
  if (!m) return null;
  const [, , user, password, host, port, database] = m;
  const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
  const useSSL = trimmed.includes('sslmode=verify-full')
    ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
    : trimmed.includes('ssl=true') || trimmed.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined;
  return {
    user: dec(user), password: dec(password),
    host: process.env.DB_HOST_IP || host,
    port: parseInt(port, 10), database,
    ssl: useSSL,
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('[migrate] DATABASE_URL not set — skipping');
    return;
  }

  const parsed = parseDbUrl(databaseUrl);
  if (!parsed) {
    console.error('[migrate] Could not parse DATABASE_URL — skipping');
    return;
  }
  console.log('[migrate] connecting host=' + parsed.host + ':' + parsed.port + '/db=' + parsed.database);

  const { Pool } = require('pg');
  const pool = new Pool({
    ...parsed,
    connectionTimeoutMillis: 15000,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows: applied } = await pool.query('SELECT name FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ok = 0, skipped = 0, errors = 0;

    for (const file of files) {
      if (appliedSet.has(file)) { skipped++; continue; }

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

      try {
        if (isNonTransactional(sql)) {
          for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
            try { await pool.query(stmt + ';'); } catch (e) {
              if (!isAlreadyExistsError(e.message)) throw e;
            }
          }
        } else {
          await pool.query(sql);
        }
        await pool.query('INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
        console.log(`[migrate] ✓ ${file}`);
        ok++;
      } catch (e) {
        if (isAlreadyExistsError(e.message)) {
          await pool.query('INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
          skipped++;
        } else {
          console.error(`[migrate] ✗ ${file}: ${e.message}`);
          errors++;
        }
      }
    }

    console.log(`[migrate] done: ${ok} applied, ${skipped} skipped, ${errors} errors`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[migrate] fatal:', err.message);
  // Non-zero exit only on unexpected failure — don't block server start
  process.exitCode = 0;
});
