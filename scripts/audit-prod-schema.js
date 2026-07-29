/**
 * Аудит боевой схемы — ТОЛЬКО ЧТЕНИЕ.
 *
 * Отвечает на вопросы, на которые весь день отвечали рассуждением: что реально
 * лежит в проде, какие миграции применились, создался ли уникальный индекс.
 *
 * Из базы выходят ТОЛЬКО метаданные и счётчики: имена таблиц, колонок, типов,
 * индексов, имена миграций и количества строк. Ни одного значения из
 * пользовательских данных — ни почты, ни имени, ни телефона. Это важно не
 * только по 152-ФЗ: вывод уезжает в лог GitHub Actions.
 *
 * Запуск: DATABASE_URL=... node scripts/audit-prod-schema.js
 */

const { Pool } = require('pg');
const { readdirSync } = require('fs');
const { join } = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

// Тот же способ подключения, что у самого приложения (lib/db-pool.ts):
// managed PostgreSQL отдаёт сертификат, который не проходит стандартную
// проверку цепочки, поэтому приложение живёт с rejectUnauthorized: false.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

/** Таблицы, о форме которых я сегодня делал выводы. */
const TABLES = [
  'users',
  'partners',
  'notifications',
  'chat_sessions',
  'operator_tours',
  'tour_availability',
  'operator_bookings',
  // Главный открытый вопрос: в проде `bookings` оказалась БАЗОВОЙ ТАБЛИЦЕЙ, а
  // не представлением, как считалось при правке бронирования тура. Нужны её
  // настоящие колонки и число строк.
  'bookings',
  'tours',
  // Таблицы восьми неприменившихся миграций: отсутствие любой из них объясняет
  // отказ без выполнения миграции на живой базе.
  'kamchatka_routes',
  'places',
  'agent_memory',
  'ai_actions_log',
  'smart_notifications_log',
  'user_place_photos',
  'place_safety_reports',
];

function header(text) {
  console.log(`\n${'='.repeat(70)}\n${text}\n${'='.repeat(70)}`);
}

async function main() {
  header('1. ФАКТИЧЕСКИЕ КОЛОНКИ');
  const cols = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [TABLES],
  );
  const byTable = new Map();
  for (const r of cols.rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(
      `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`,
    );
  }
  for (const t of TABLES) {
    const list = byTable.get(t);
    console.log(`\n-- ${t}${list ? '' : '  ← ТАБЛИЦЫ НЕТ'}`);
    if (list) list.forEach((c) => console.log(`   ${c}`));
  }

  header('2. ЭТО ТАБЛИЦА ИЛИ ПРЕДСТАВЛЕНИЕ');
  const kinds = await pool.query(
    `SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN ('bookings','tours','agent_route_knowledge','v_kamchatka_routes_api')
      ORDER BY table_name`,
  );
  kinds.rows.forEach((r) => console.log(`   ${r.table_name}: ${r.table_type}`));

  header('2.1 ФУНКЦИИ');
  // translit_ru_slug создаёт миграция 779: нет функции — 779 не дошла до бэкфилла.
  const fns = await pool.query(
    `SELECT p.proname FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname = ANY($1)`,
    [['translit_ru_slug']],
  );
  const present = new Set(fns.rows.map((r) => r.proname));
  ['translit_ru_slug'].forEach((n) => console.log(`   ${n}: ${present.has(n) ? 'есть' : 'НЕТ'}`));

  header('3. МИГРАЦИИ');
  const applied = await pool.query('SELECT name FROM _migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.name));
  const files = readdirSync(join(process.cwd(), 'migrations')).filter((f) => f.endsWith('.sql'));
  const unapplied = files.filter((f) => !appliedSet.has(f)).sort();

  console.log(`   применено:   ${appliedSet.size}`);
  console.log(`   файлов в репозитории: ${files.length}`);
  console.log(`   НЕ применено: ${unapplied.length}`);
  // ВАЖНО: считаем по файлам ТЕКУЩЕГО репозитория, а у прода образ может быть
  // старее. Миграция, которой нет в его образе, тоже попадёт в этот список.
  unapplied.forEach((f) => console.log(`     ✗ ${f}`));

  const recent = await pool.query(
    'SELECT name, applied_at FROM _migrations ORDER BY applied_at DESC NULLS LAST LIMIT 10',
  );
  console.log('\n   последние применённые:');
  recent.rows.forEach((r) => console.log(`     ${r.applied_at?.toISOString?.() ?? r.applied_at}  ${r.name}`));

  header('4. ИНДЕКСЫ users + ДУБЛИ telegram_id');
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='users' ORDER BY indexname`,
  );
  idx.rows.forEach((r) => console.log(`   ${r.indexname}`));

  const hasTg = (byTable.get('users') ?? []).some((c) => c.startsWith('telegram_id '));
  if (hasTg) {
    const dup = await pool.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL
          GROUP BY telegram_id HAVING COUNT(*) > 1) d`,
    );
    console.log(`   дублей telegram_id: ${dup.rows[0].n}`);
  } else {
    console.log('   колонки telegram_id нет — дубли не считаем');
  }

  header('5. СЧЁТЧИКИ (без содержимого)');
  for (const t of ['notifications', 'chat_sessions', 'operator_bookings', 'users', 'bookings', 'tours']) {
    if (!byTable.has(t)) { console.log(`   ${t}: таблицы нет`); continue; }
    const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    console.log(`   ${t}: ${c.rows[0].n}`);
  }
}

main()
  .catch((e) => { console.error('ОШИБКА:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
