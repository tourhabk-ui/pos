/**
 * Контент-дедуп external_alerts на настоящем PostgreSQL.
 *
 * ── Почему этот файл существует ─────────────────────────────────────────
 *
 * 09.09 в 02:37 на прод уехал #1745: дедуп-UPDATE в saveEvent получил
 * `FROM (...) prev`, чтобы отличать «срок продлён» от «перечитали то же
 * самое». В SET осталось голое `GREATEST(expires_at, $4)` — и с двумя
 * колонками этого имени в области видимости PostgreSQL отвечает 42702
 * «column reference "expires_at" is ambiguous». На КАЖДЫЙ пост каждого
 * источника. Двадцать часов конвейер безопасности не сохранил ни одного
 * алерта: `published` замер на 02:39, `fetch_failed` вырос с 20 до 1031.
 *
 * Полный юнит-прогон при этом был зелёным — 10 025 тестов. Моки отвечают
 * `{ rowCount: 0 }` на любой текст запроса; разбор имён колонок делает только
 * сервер (тот же урок, что 42P08 в CLAUDE.md §4.0: «судить статикой
 * ЗАПРЕЩЕНО»). Значит единственный сторож формы этого запроса — настоящая
 * база, и он здесь.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  console.warn('[alert-dedup.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

/**
 * СВОЯ БАЗА, а не своя схема — и вот почему не схема.
 *
 * Правило pg-tests-run-in-ci: новый pg-файл не сидит в public, иначе он
 * заложник порядка запуска соседей. Соседи изолируются схемой через
 * `options: -c search_path=...` на СВОЁМ пуле. Здесь так нельзя: saveEvent
 * пишет через пул ПРИЛОЖЕНИЯ (`@/lib/db-pool`), а тот разбирает DATABASE_URL
 * на поля user/host/database и параметры строки соединения теряет — schema
 * до него не доедет. Править db-pool ради теста в хотфиксе — не тот размен.
 *
 * Имя базы же до пула доезжает. Поэтому bootstrap-соединение заводит
 * отдельную базу, и DATABASE_URL для приложения указывает на неё. Race с
 * public соседей исключён по построению, а не по удаче.
 */
const TEST_DB = 'alert_dedup_test';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

if (PG_URL) {
  process.env.DATABASE_URL = withDatabase(PG_URL, TEST_DB);
  process.env.DATABASE_SSL = 'false';
}

type Parser = typeof import('@/lib/services/safety/seismic-parser');
type SeismicEvent = import('@/lib/services/safety/seismic-parser').SeismicEvent;

/**
 * DDL external_alerts — из САМОЙ миграции, а не переписан руками: тест
 * обязан видеть те же колонки, что и прод, иначе он снова проверял бы
 * не то. Берётся блок CREATE TABLE из 070 плюс колонки 687 (magnitude,
 * lat, lng), которые saveEvent пишет.
 */
function externalAlertsDdl(): string {
  const m070 = readFileSync(join(process.cwd(), 'migrations', '070_safety_capacity_layer_fix.sql'), 'utf-8');
  const block = m070.match(/CREATE TABLE IF NOT EXISTS external_alerts \([\s\S]*?\);/);
  if (!block) throw new Error('в миграции 070 не найден CREATE TABLE external_alerts');
  const m687 = readFileSync(join(process.cwd(), 'migrations', '687_external_alerts_coords.sql'), 'utf-8');
  return `${block[0]}\n${m687}`;
}

// Даты — ОТНОСИТЕЛЬНО «сейчас», не литералом. Первая редакция (09.09) ставила
// published_at = 2026-09-09T10:00Z при expires_hours 24: дедуп ищет живой
// оригинал (`expires_at > NOW()`), и на следующий день после 10:00 UTC все
// три проверки покраснели сами по себе — kernel-pg на main лёг без единой
// правки кода (10.09). Тест с зашитой датой — бомба с часовым механизмом.
const HOUR = 3_600_000;
const PUBLISHED_AT = new Date(Date.now() - 3 * HOUR);

function sampleEvent(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    source_id: 't.me/kbgsras/pg-test-1',
    source_url: 'https://t.me/kbgsras/pg-test-1',
    published_at: PUBLISHED_AT,
    alert_type: 'earthquake',
    severity: 1,
    title: 'Землетрясение магнитудой 4.2 в 90 км от Петропавловска',
    description: 'Ощущалось в городе, разрушений нет.',
    affected_zones: ['avachinsky'],
    expires_hours: 24,
    ...overrides,
  };
}

withPg('дедуп external_alerts на настоящем PostgreSQL', () => {
  let parser: Parser;
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Базу заводим отдельным соединением к исходной: указать её в URL можно
    // только после того, как она существует. CREATE DATABASE не знает
    // IF NOT EXISTS — спрашиваем каталог.
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    const { rows } = await bootstrap.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEST_DB]);
    if (rows.length === 0) await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: withDatabase(PG_URL, TEST_DB), max: 4 });
    await pool.query(externalAlertsDdl());
    // Ledger нужен, потому что saveEvent пишет в него; он fail-soft, но
    // пусть пишет по-настоящему — так виден и порядок событий.
    await pool.query(readFileSync(join(process.cwd(), 'migrations', '925_safety_decision_events.sql'), 'utf-8'));
    parser = await import('@/lib/services/safety/seismic-parser');
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`DELETE FROM external_alerts WHERE external_id LIKE 't.me/kbgsras/pg-test-%'`);
  });

  afterAll(async () => {
    const { pool: appPool } = await import('@/lib/db-pool');
    await appPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    // База — временная. Не удалилась (кто-то держит соединение) — не беда:
    // следующий прогон найдёт её в каталоге и переиспользует.
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
    await bootstrap.end().catch(() => undefined);
  });

  it('первый сигнал ВСТАВЛЯЕТСЯ — дедуп-UPDATE на пустой таблице не падает', async () => {
    // Ровно этот вызов падал на проде 20 часов: UPDATE с FROM-подзапросом
    // выполняется ДО INSERT, и голая колонка в SET роняла его на 42702.
    const r = await parser.saveEvent(sampleEvent());
    expect(r).toBe('inserted');
    const { rows } = await pool.query(
      `SELECT external_id, expires_at FROM external_alerts WHERE external_id = $1`,
      ['t.me/kbgsras/pg-test-1'],
    );
    expect(rows).toHaveLength(1);
  });

  it('тот же текст при живом оригинале — skipped, строка одна', async () => {
    expect(await parser.saveEvent(sampleEvent())).toBe('inserted');
    // Другой external_id, тот же текст — контентный дедуп, не ON CONFLICT.
    expect(await parser.saveEvent(sampleEvent({ source_id: 't.me/kbgsras/pg-test-2' }))).toBe('skipped');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM external_alerts WHERE external_id LIKE 't.me/kbgsras/pg-test-%'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('повтор с более поздней публикацией ПРОДЛЕВАЕТ срок оригинала', async () => {
    await parser.saveEvent(sampleEvent());
    const before = (await pool.query(
      `SELECT expires_at FROM external_alerts WHERE external_id = $1`, ['t.me/kbgsras/pg-test-1'],
    )).rows[0].expires_at as Date;

    const later = sampleEvent({
      source_id: 't.me/kbgsras/pg-test-3',
      published_at: new Date(PUBLISHED_AT.getTime() + 10 * HOUR),
    });
    expect(await parser.saveEvent(later)).toBe('skipped');

    const after = (await pool.query(
      `SELECT expires_at FROM external_alerts WHERE external_id = $1`, ['t.me/kbgsras/pg-test-1'],
    )).rows[0].expires_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('повтор с тем же сроком ничего не меняет и не пишет dedup_skipped', async () => {
    await parser.saveEvent(sampleEvent());
    const { rows: beforeLedger } = await pool.query(
      `SELECT count(*)::int AS n FROM safety_decision_events WHERE event_type = 'dedup_skipped'`,
    );
    expect(await parser.saveEvent(sampleEvent({ source_id: 't.me/kbgsras/pg-test-4' }))).toBe('skipped');
    const { rows: afterLedger } = await pool.query(
      `SELECT count(*)::int AS n FROM safety_decision_events WHERE event_type = 'dedup_skipped'`,
    );
    // GREATEST вернул прежнее значение — события нет: перечитанная лента не
    // событие. Именно ради этого различия и появился FROM-подзапрос.
    expect(afterLedger[0].n).toBe(beforeLedger[0].n);
  });
});
