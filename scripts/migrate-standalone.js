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

/**
 * Режет SQL-файл на выражения по «точке с запятой», понимая синтаксис, а не
 * байты: разделитель не действует внутри строк ('...', с удвоением ''),
 * комментариев (--, слэш-звёздочка) и dollar-quoted блоков ($tag$...$tag$).
 *
 * Урок миграции 843 (09.08): наивный split по каждому вхождению разрезал
 * русский SQL-комментарий, содержавший этот символ, пополам — и Postgres
 * получил «выражение», начинающееся с половины слова из комментария:
 * `syntax error at or near "условие"`. Из четырёх индексов на прод доехал
 * один, миграция ретраилась каждый деплой.
 */
function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let state = 'code'; // code | line | block | quote | dollar
  let dollarTag = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (state === 'code') {
      if (ch === '-' && next === '-') {
        state = 'line'; buf += ch;
      } else if (ch === '/' && next === '*') {
        state = 'block'; buf += ch;
      } else if (ch === "'") {
        state = 'quote'; buf += ch;
      } else if (ch === '$') {
        const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
        if (m) { state = 'dollar'; dollarTag = m[0]; buf += m[0]; i += m[0].length; continue; }
        buf += ch;
      } else if (ch === ';') {
        out.push(buf); buf = '';
      } else {
        buf += ch;
      }
    } else if (state === 'line') {
      buf += ch;
      if (ch === '\n') state = 'code';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { buf += '*/'; i += 2; state = 'code'; continue; }
      buf += ch;
    } else if (state === 'quote') {
      if (ch === "'" && next === "'") { buf += "''"; i += 2; continue; }
      buf += ch;
      if (ch === "'") state = 'code';
    } else { // dollar
      if (sql.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; state = 'code'; continue; }
      buf += ch;
    }
    i += 1;
  }
  if (buf.trim()) out.push(buf);
  // Кусок из одних комментариев и пустот — не выражение: нечего слать в базу.
  return out
    .map(s => s.trim())
    .filter(s => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
}

/**
 * Причина отказа сохраняется в базу, а оттуда её показывает аудит и вотчдог.
 * Значит текст уезжает в лог GitHub Actions — то есть за границу. Сообщения
 * Postgres обычно состоят из имён объектов, но некоторые несут значения
 * (`invalid input syntax for type uuid: "..."`), а значением может оказаться
 * почта или телефон туриста. Поэтому детерминированно глушим то, что похоже на
 * персональные данные, и режем длину: диагностическая ценность в имени колонки
 * и типе ошибки, а не в значении.
 */
function scrubError(msg) {
  return String(msg || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[почта]')
    .replace(/\+?\d[\d\s()-]{9,}\d/g, '[телефон]')
    .slice(0, 400);
}

function isAlreadyExistsError(msg) {
  const l = msg.toLowerCase();
  return l.includes('already exists')
    || l.includes('duplicate key')
    || l.includes('duplicate column')
    || l.includes('already have');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('[migrate] DATABASE_URL not set — skipping');
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('sslmode=verify-full')
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
      : databaseUrl.includes('ssl=true') || databaseUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
    connectionTimeoutMillis: 15000,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Провал миграции до сих пор оставался строчкой в логе деплоя, который
    // никто не читает на следующий день. Восемь неприменившихся миграций на
    // проде пришлось разбирать по форме схемы, гадая о причине. Теперь причина
    // хранится рядом с самим фактом: строка живёт, пока миграция не пройдёт.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migration_failures (
        name            TEXT PRIMARY KEY,
        error           TEXT NOT NULL,
        attempts        INT NOT NULL DEFAULT 1,
        first_failed_at TIMESTAMPTZ DEFAULT NOW(),
        last_failed_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows: applied } = await pool.query('SELECT name FROM _migrations');
    const appliedSet = new Set(applied.map(r => r.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ok = 0, skipped = 0, errors = 0;

    // ВАЖНО: один выделенный клиент на весь цикл. Раньше использовался
    // pool.query() — и если транзакционная миграция (с BEGIN/COMMIT) падала
    // на середине, соединение оставалось в состоянии «прерванной транзакции»
    // (aborted transaction). Пул мог отдать это же соединение следующей
    // миграции, и та падала с `current transaction is aborted, commands
    // ignored until end of transaction block` — даже если сама по себе была
    // корректной. Так одна упавшая миграция отравляла все последующие.
    // Теперь после КАЖДОЙ ошибки делаем ROLLBACK на этом же клиенте, очищая
    // состояние транзакции перед следующей миграцией.
    const client = await pool.connect();
    try {
      for (const file of files) {
        if (appliedSet.has(file)) { skipped++; continue; }

        const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

        try {
          if (isNonTransactional(sql)) {
            for (const stmt of splitSqlStatements(sql)) {
              try { await client.query(stmt + ';'); } catch (e) {
                if (!isAlreadyExistsError(e.message)) throw e;
              }
            }
          } else {
            await client.query(sql);
          }
          await client.query('INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]);
          // Прошла — прошлая запись о провале больше не факт, а мусор.
          await client.query('DELETE FROM _migration_failures WHERE name = $1', [file]).catch(() => {});
          console.log(`[migrate] ✓ ${file}`);
          ok++;
        } catch (e) {
          // Снять возможную прерванную транзакцию, чтобы не отравить следующие.
          await client.query('ROLLBACK').catch(() => {});
          if (isAlreadyExistsError(e.message)) {
            await client.query('INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [file]).catch(() => {});
            await client.query('DELETE FROM _migration_failures WHERE name = $1', [file]).catch(() => {});
            skipped++;
          } else {
            console.error(`[migrate] ✗ ${file}: ${e.message}`);
            await client.query(
              `INSERT INTO _migration_failures(name, error) VALUES($1, $2)
               ON CONFLICT (name) DO UPDATE
                 SET error = EXCLUDED.error,
                     attempts = _migration_failures.attempts + 1,
                     last_failed_at = NOW()`,
              [file, scrubError(e.message)],
            ).catch(() => {});
            errors++;
          }
        }
      }
    } finally {
      client.release();
    }

    console.log(`[migrate] done: ${ok} applied, ${skipped} skipped, ${errors} errors`);
  } finally {
    await pool.end();
  }
}

// Запуск только как скрипта: экспорт нужен, чтобы глушение персональных данных
// проверялось тестом, а не на глаз. Без этой проверки `require` из теста
// поднимал бы миграции.
if (require.main === module) {
  main().catch(err => {
    console.error('[migrate] fatal:', err.message);
    // Non-zero exit only on unexpected failure — don't block server start
    process.exitCode = 0;
  });
}

module.exports = { scrubError, isNonTransactional, isAlreadyExistsError, splitSqlStatements };
