#!/usr/bin/env node
/**
 * Восстановление схемы БД из baseline на ПУСТОЙ базе (задача #57).
 *
 * Сценарий катастрофы: прод-БД утрачена, миграции с нуля не проигрываются
 * (историческая цепочка 001..N писалась поверх живой базы). Тогда:
 *   DATABASE_URL=<новая БД> node scripts/bootstrap-from-baseline.js
 *
 * Делает три вещи:
 *  1. Отказывается работать на НЕпустой базе (жизнь дороже: baseline не
 *     мигратор и не должен касаться живых данных). Обойти: --force.
 *  2. Применяет lib/database/baseline/schema-baseline.sql повыражённо
 *     (сплиттер — общий с раннером миграций, урок 843).
 *  3. Помечает ВСЕ файлы migrations/ применёнными в _migrations — дальше
 *     новая база живёт обычным циклом деплоя (start.js применяет только
 *     миграции новее baseline).
 *
 * Обновление baseline: пуш trigger-файла в ветку db-baseline воркфлоу
 * .github/workflows/db-baseline.yml (снимает живую схему с прода).
 */

const { readFile, readdir } = require('fs/promises');
const { resolve, join } = require('path');
const { splitSqlStatements } = require('./migrate-standalone.js');

const BASELINE = resolve(__dirname, '..', 'lib', 'database', 'baseline', 'schema-baseline.sql');
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[bootstrap] DATABASE_URL не задан');
    process.exit(1);
  }
  const force = process.argv.includes('--force');

  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_class c
         JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relkind = 'r'`,
    );
    if (rows[0].n > 0 && !force) {
      console.error(
        `[bootstrap] В базе уже ${rows[0].n} таблиц — baseline применяется только на пустую базу. ` +
        'Если вы точно понимаете, что делаете: --force.',
      );
      process.exit(1);
    }

    const sql = await readFile(BASELINE, 'utf8');
    const statements = splitSqlStatements(sql);
    console.log(`[bootstrap] выражений в baseline: ${statements.length}`);

    let ok = 0, skipped = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        ok++;
      } catch (e) {
        // На пустой базе ошибок быть не должно; «already exists» терпим
        // ради повторного запуска после обрыва.
        if (/already exists|duplicate/i.test(e.message)) { skipped++; continue; }
        console.error(`[bootstrap] ОШИБКА: ${e.message}\n  на выражении: ${stmt.slice(0, 120)}`);
        process.exit(1);
      }
    }
    console.log(`[bootstrap] схема применена: ${ok} выражений (${skipped} уже были)`);

    // Пометить все миграции применёнными — они уже «внутри» baseline.
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      await client.query(
        'INSERT INTO _migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [f],
      );
    }
    console.log(`[bootstrap] миграций помечено применёнными: ${files.length}`);
    console.log('[bootstrap] готово — дальше база живёт обычным циклом деплоя');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[bootstrap] fatal:', e.message);
    process.exit(1);
  });
}
