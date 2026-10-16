/**
 * Схема прода для интеграционных тестов — один шаблон на прогон.
 *
 * ── Повод (аудит 15.10, находка P2-10, пункт 1.8) ─────────────────────────
 *
 * Четырнадцать `*.pg.test.ts` строили схему каждый сам: создать базу,
 * `bootstrap-from-baseline.js`, стереть из `_migrations` всё новее границы,
 * `migrate.ts`. Четырнадцать копий одного ритуала — с тремя разными формами
 * предиката (`substring(...)::bigint`, `regexp_match(...)::int`, с
 * безномерными и без) и одной общей вещью: литералом 863. Пересъём baseline
 * сдвинул бы границу, а копии остались бы на старой и доигрывали бы поверх
 * снимка то, что в нём уже есть.
 *
 * Теперь ритуал один и живёт здесь:
 *  - граница читается из шапки baseline (`lib/database/baseline-header.ts`),
 *    а её пишет сборщик снимка — литерала нет нигде;
 *  - схема строится ОДИН раз в базу-шаблон, и каждый файл получает свою
 *    копию `CREATE DATABASE … TEMPLATE` — одинаковую и за доли секунды;
 *  - шаблон помечен отпечатком входа (baseline, раннеры, все миграции): вход
 *    изменился — шаблон перестраивается, совпал — берётся готовый.
 *
 * ── Третий исход (§4.0) ───────────────────────────────────────────────────
 *
 * Граница не записана, файл границы не найден в каталоге, безномерная
 * миграция, не вся «новее границы» доиграна — каждый случай бросает с
 * названной причиной. Шаблон, построенный «как получилось», выдавал бы
 * неполную схему за схему прода, и зелёный тест на ней не значил бы ничего.
 * Отпечаток пишется ПОСЛЕДНИМ шагом: недостроенный шаблон отпечатка не
 * имеет и следующим вызовом перестраивается, а не берётся.
 *
 * ── Гонка ────────────────────────────────────────────────────────────────
 *
 * Проверка, перестройка и копия идут под одной advisory-блокировкой
 * административной базы: два файла (или два дерева с разным кодом на одном
 * сервере) не перестроят шаблон друг у друга из-под копии. Шаблон закрыт для
 * подключений (`ALLOW_CONNECTIONS false`) — `CREATE DATABASE … TEMPLATE`
 * требует, чтобы к источнику не был подключён никто.
 */
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseBaselineHeader } from '@/lib/database/baseline-header';
import {
  isAfterBaseline, sortMigrations, unnumberedMigrations,
} from '@/lib/database/migration-order';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'migrations');
export const BASELINE_PATH = join(ROOT, 'lib', 'database', 'baseline', 'schema-baseline.sql');
const BOOTSTRAP = join(ROOT, 'scripts', 'bootstrap-from-baseline.js');
const MIGRATE = join(ROOT, 'lib', 'database', 'migrate.ts');

/** База-шаблон. Имя постоянное: шаблон живёт между прогонами, пока вход тот же. */
export const SCHEMA_TEMPLATE_DB = 'vedar_schema_template';

/**
 * Входы, от которых зависит схема шаблона. Изменился любой — шаблон устарел.
 * Сам этот файл — тоже вход: правка порядка постройки обязана перестроить
 * шаблон, а не молча взять собранный прежним кодом.
 */
const FINGERPRINT_INPUTS = [
  join(ROOT, 'tests', 'helpers', 'pg-schema.ts'),
  join(ROOT, 'lib', 'database', 'baseline-header.ts'),
  BASELINE_PATH,
  BOOTSTRAP,
  join(ROOT, 'scripts', 'migrate-standalone.js'),
  MIGRATE,
  join(ROOT, 'lib', 'database', 'migration-order.ts'),
];

const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function assertDbName(db: string): void {
  if (!DB_NAME.test(db)) throw new Error(`Имя тестовой базы «${db}» недопустимо: только [a-z0-9_], до 63 знаков`);
}

/** URL той же машины, но другой базы. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function migrationFiles(): string[] {
  return sortMigrations(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')));
}

export interface BaselineBoundary {
  /** Последняя миграция, вошедшая в снимок (из шапки baseline). */
  lastMigration: string;
  /** Первый номер после снимка. */
  firstAfter: number;
  /** Миграции каталога, которые доигрываются поверх снимка, в порядке применения. */
  replay: string[];
}

/**
 * Граница снимка — из шапки baseline, сверенная с каталогом. Не установлена
 * или не сходится с каталогом — бросает: строить по догадке нельзя.
 */
export function baselineBoundary(): BaselineBoundary {
  const header = parseBaselineHeader(readFileSync(BASELINE_PATH, 'utf8'));
  if (header.lastMigration === null || header.firstAfter === null) {
    throw new Error(
      'В шапке lib/database/baseline/schema-baseline.sql нет строки «-- Последняя миграция в снимке: NNN_имя.sql» — '
      + 'граница снимка не установлена, шаблон схемы не строится (§4.0). Её пишет scripts/assemble-db-baseline.py.',
    );
  }
  const files = migrationFiles();
  if (!files.includes(header.lastMigration)) {
    throw new Error(
      `Шапка baseline называет последней миграцией снимка «${header.lastMigration}», а в migrations/ такого файла нет — `
      + 'граница не сходится с каталогом, шаблон схемы не строится.',
    );
  }
  const unnumbered = unnumberedMigrations(files);
  if (unnumbered.length > 0) {
    throw new Error(
      `В migrations/ файлы без номера: ${unnumbered.join(', ')} — не разобрать, до или после снимка они, шаблон не строится.`,
    );
  }
  const firstAfter = header.firstAfter;
  return {
    lastMigration: header.lastMigration,
    firstAfter,
    replay: files.filter((f) => isAfterBaseline(f, firstAfter)),
  };
}

/** Отпечаток входа шаблона: baseline, раннеры и каждая миграция (имя и текст). */
export function schemaFingerprint(): string {
  const h = createHash('sha256');
  for (const p of FINGERPRINT_INPUTS) {
    h.update(p.slice(ROOT.length));
    h.update('\0');
    h.update(readFileSync(p));
    h.update('\0');
  }
  for (const f of migrationFiles()) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(MIGRATIONS_DIR, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Baseline + доигрывание миграций новее границы — в пустую базу по URL. */
async function buildSchema(dbUrl: string, boundary: BaselineBoundary): Promise<void> {
  const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
  execFileSync('node', [BOOTSTRAP], { env, stdio: 'pipe' });

  // bootstrap помечает применёнными ВСЕ файлы каталога; новее границы — снять
  // пометку, чтобы раннер их доиграл. Список считает migration-order, а не
  // предикат в SQL: `name >= '863'` уже раз ошибся на тысячной миграции.
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const del = await c.query('DELETE FROM _migrations WHERE name = ANY($1::text[])', [boundary.replay]);
    if (del.rowCount !== boundary.replay.length) {
      throw new Error(
        `bootstrap пометил применёнными ${del.rowCount ?? 0} из ${boundary.replay.length} миграций новее снимка — `
        + 'журнал не тот, что ожидался, шаблон не строится.',
      );
    }
  } finally {
    await c.end();
  }

  execFileSync('npx', ['tsx', MIGRATE], { env, stdio: 'pipe' });

  // Раннер падает на настоящей ошибке сам; здесь — что он не промолчал.
  const v = new Client({ connectionString: dbUrl });
  await v.connect();
  try {
    const done = await v.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM _migrations WHERE name = ANY($1::text[])', [boundary.replay],
    );
    if (done.rows[0].n !== boundary.replay.length) {
      throw new Error(
        `После раннера применено ${done.rows[0].n} из ${boundary.replay.length} миграций новее снимка — шаблон неполон.`,
      );
    }
  } finally {
    await v.end();
  }
}

/** Держит шаблон актуальным. Зовётся под блокировкой — из createTestDatabase. */
async function ensureTemplate(admin: Client, adminUrl: string): Promise<void> {
  const fp = schemaFingerprint();
  // COMMENT ниже параметров не принимает — отпечаток идёт литералом, и он
  // обязан быть ровно 64 hex-знаками.
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error('Отпечаток шаблона не hex — не пишу его в COMMENT');
  const cur = await admin.query<{ fp: string | null }>(
    `SELECT shobj_description(oid, 'pg_database') AS fp FROM pg_database WHERE datname = $1`,
    [SCHEMA_TEMPLATE_DB],
  );
  if (cur.rows.length > 0 && cur.rows[0].fp === fp) return;

  const boundary = baselineBoundary();
  if (cur.rows.length > 0) {
    // Шаблон помечен шаблоном и закрыт для подключений — снять, иначе не удалить.
    await admin.query(`ALTER DATABASE ${SCHEMA_TEMPLATE_DB} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
    await admin.query(`DROP DATABASE ${SCHEMA_TEMPLATE_DB} WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE ${SCHEMA_TEMPLATE_DB}`);
  await buildSchema(withDatabase(adminUrl, SCHEMA_TEMPLATE_DB), boundary);

  // Отпечаток — последним: недостроенный шаблон его не имеет и перестроится.
  await admin.query(`COMMENT ON DATABASE ${SCHEMA_TEMPLATE_DB} IS '${fp}'`);
  await admin.query(`ALTER DATABASE ${SCHEMA_TEMPLATE_DB} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
}

/**
 * Своя база файла со схемой прода: baseline + миграции новее снимка.
 *
 * `adminUrl` — KERNEL_PG_TEST_URL: база, к которой подключаются, чтобы
 * создавать другие. Прежняя база `db` удаляется. Возвращает URL новой базы.
 * Первый вызов на сервере строит шаблон (секунды), следующие — копируют.
 */
export async function createTestDatabase(adminUrl: string, db: string): Promise<string> {
  assertDbName(db);
  if (db === SCHEMA_TEMPLATE_DB) throw new Error('Тестовой базе нельзя называться как шаблон');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [SCHEMA_TEMPLATE_DB]);
    await ensureTemplate(admin, adminUrl);
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db} TEMPLATE ${SCHEMA_TEMPLATE_DB}`);
  } finally {
    // Конец сессии снимает и блокировку.
    await admin.end();
  }
  return withDatabase(adminUrl, db);
}

/**
 * Удалить базу файла после прогона.
 *
 * `pool.end()` снимает клиентов из пула, не дожидаясь, пока закроются их
 * сокеты. `DROP DATABASE … WITH (FORCE)` сразу следом обрывал ещё
 * закрывающееся соединение: сервер отвечал ему FATAL 57P01, и клиент без
 * слушателя ошибок выбрасывал её необработанной. Прогон краснел «ошибкой вне
 * тестов» при зелёных тестах — видно при параллельном полном прогоне
 * (widget-measure, 15.10). Поэтому сначала ждём, пока у базы не останется
 * сеансов, и только потом удаляем; FORCE остаётся на случай, если сеанс не
 * ушёл за срок, — это уже утечка соединения в самом тесте.
 */
export async function dropTestDatabase(adminUrl: string, db: string, waitMs = 5_000): Promise<void> {
  assertDbName(db);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [db],
      );
      if (rows[0]!.n === 0 || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
