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
 * DDL external_alerts — из САМИХ миграций, а не переписан руками: тест
 * обязан видеть те же колонки, что и прод, иначе он снова проверял бы
 * не то. Берётся блок CREATE TABLE из 070 плюс колонки 687 (magnitude,
 * lat, lng), 1044 (volcano_name, volcano_ark_id) и 1124 (affected_parks) — всё,
 * что пишет saveEvent.
 *
 * Список ведётся вручную по необходимости, и это видно сразу: 27.09 привязка
 * вулканического алерта к вулкану добавила две колонки, saveEvent начал их
 * писать, и все семь проверок этого файла покраснели с внятным «column
 * volcano_name of relation external_alerts does not exist». Именно так и
 * должно быть — тест поймал расхождение своей схемы с прод-схемой сам.
 */
function externalAlertsDdl(): string {
  const m070 = readFileSync(join(process.cwd(), 'migrations', '070_safety_capacity_layer_fix.sql'), 'utf-8');
  const block = m070.match(/CREATE TABLE IF NOT EXISTS external_alerts \([\s\S]*?\);/);
  if (!block) throw new Error('в миграции 070 не найден CREATE TABLE external_alerts');
  const m687 = readFileSync(join(process.cwd(), 'migrations', '687_external_alerts_coords.sql'), 'utf-8');
  const m1044 = readFileSync(join(process.cwd(), 'migrations', '1102_alert_volcano_anchor.sql'), 'utf-8');
  // 1124 (#2133): affected_parks — saveEvent пишет её с закрытием парков.
  // Из файла берётся только ALTER этой таблицы: остальное в 1124 пишет в
  // parks, которой в этой базе нет.
  const m1124 = readFileSync(join(process.cwd(), 'migrations', '1124_park_closure_alerts.sql'), 'utf-8');
  const parksCol = m1124.match(/ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS affected_parks [^;]+;/);
  if (!parksCol) throw new Error('в миграции 1124 не найдена колонка affected_parks');
  // 1212 (10.10): основание пункта ленты — проверки «основания дорожного
  // закрытия» ниже пишут и читают его колонки.
  const m1212 = readFileSync(join(process.cwd(), 'migrations', '1212_external_alerts_basis.sql'), 'utf-8');
  // 1394 (06.11): дата последней сводки и кто погасил — saveEvent пишет
  // last_published_at и сверяет ended_by. Файл трогает только эту таблицу.
  const m1394 = readFileSync(join(process.cwd(), 'migrations', '1394_external_alerts_park_status.sql'), 'utf-8');
  return `${block[0]}\n${m687}\n${m1044}\n${parksCol[0]}\n${m1212}\n${m1394}`;
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

  it('повтор с БОЛЬШИМ разрядом поднимает severity у живого алерта', async () => {
    // Случай 13.09: сводка УГМС о паводке ОЯ принята с severity 1, через час
    // вышла правка классификатора, поднимающая ОЯ до двойки. Без переоценки
    // строка жила бы единицей все свои 120 часов — то есть починка есть, а до
    // туриста она не доходит. Ниже двойки нет ни пуша, ни красного статуса.
    await parser.saveEvent(sampleEvent({ severity: 1 }));
    expect(await parser.saveEvent(sampleEvent({
      source_id: 't.me/kbgsras/pg-test-5', severity: 2,
    }))).toBe('skipped');

    const { rows } = await pool.query(
      `SELECT severity FROM external_alerts WHERE external_id = $1`, ['t.me/kbgsras/pg-test-1'],
    );
    expect(Number(rows[0].severity)).toBe(2);
    // Одна строка, не две: переоценка — это UPDATE, а не новый алерт.
    const { rows: cnt } = await pool.query(
      `SELECT count(*)::int AS n FROM external_alerts WHERE external_id LIKE 't.me/kbgsras/pg-test-%'`,
    );
    expect(cnt[0].n).toBe(1);
  });

  it('повтор с МЕНЬШИМ разрядом severity НЕ понижает', async () => {
    // Понижение опаснее отсутствия правки: переформулированная сводка с тем же
    // заголовком молча сняла бы красный статус и отменила ещё не ушедший пуш.
    await parser.saveEvent(sampleEvent({ severity: 2 }));
    expect(await parser.saveEvent(sampleEvent({
      source_id: 't.me/kbgsras/pg-test-6', severity: 1,
    }))).toBe('skipped');

    const { rows } = await pool.query(
      `SELECT severity FROM external_alerts WHERE external_id = $1`, ['t.me/kbgsras/pg-test-1'],
    );
    expect(Number(rows[0].severity)).toBe(2);
  });

  it('переоценка разряда попадает в журнал даже без сдвига срока', async () => {
    // Алерт внезапно становится громче — в журнале обязано остаться, почему.
    await parser.saveEvent(sampleEvent({ severity: 1 }));
    const { rows: before } = await pool.query(
      `SELECT count(*)::int AS n FROM safety_decision_events WHERE event_type = 'dedup_skipped'`,
    );
    // Тот же published_at — срок не двинется, сработает только переоценка.
    await parser.saveEvent(sampleEvent({ source_id: 't.me/kbgsras/pg-test-7', severity: 2 }));
    const { rows: after } = await pool.query(
      `SELECT count(*)::int AS n FROM safety_decision_events WHERE event_type = 'dedup_skipped'`,
    );
    expect(after[0].n).toBe(before[0].n + 1);
    // Именно ПОСЛЕДНЯЯ запись, а не max() по тексту: журнал копится между
    // проверками, а «срок действия продлён» сортируется после «разряд
    // опасности поднят» — максимум взял бы чужую строку.
    const { rows: latest } = await pool.query(
      `SELECT decision_reason, details FROM safety_decision_events
        WHERE event_type = 'dedup_skipped' ORDER BY id DESC LIMIT 1`,
    );
    expect(String(latest[0].decision_reason)).toContain('разряд опасности поднят');
    expect(latest[0].details?.regraded_to_severity).toBe(2);
  });

  // ── Метки дальних округов доходят до уже сохранённых строк (09.10, #2293) ──
  const HYDRO = {
    alert_type: 'flood' as const,
    title: 'Экстренное предупреждение на 7 - 12 октября (тест дальних округов)',
    description: 'На реках Елизовского округа и Пенжинского, Олюторского районов ожидается подъём воды.',
  };
  const zonesOf = async () => (await pool.query<{ affected_zones: string[] }>(
    `SELECT affected_zones FROM external_alerts WHERE external_id = $1`, ['t.me/kbgsras/pg-test-1'],
  )).rows[0].affected_zones;

  it('строка, разобранная до меток дальних округов, получает их на повторе — и журнал называет «откуда»', async () => {
    // Так лежала гидро-тревога 7–12.10: Пенжинский → northern, Олюторский → eastern.
    await parser.saveEvent(sampleEvent({ ...HYDRO, affected_zones: ['avachinsky', 'northern', 'eastern'] }));
    expect(await parser.saveEvent(sampleEvent({
      ...HYDRO, source_id: 't.me/kbgsras/pg-test-far-2', affected_zones: ['avachinsky', 'krai_koryak'],
    }))).toBe('skipped');
    expect(await zonesOf()).toEqual(['avachinsky', 'krai_koryak']);
    const { rows: latest } = await pool.query(
      `SELECT decision_reason, details FROM safety_decision_events
        WHERE event_type = 'dedup_skipped' ORDER BY id DESC LIMIT 1`,
    );
    expect(String(latest[0].decision_reason)).toContain('зоны заменены');
    expect(latest[0].details?.rezoned_from).toEqual(['avachinsky', 'northern', 'eastern']);
    expect(latest[0].details?.rezoned_to).toEqual(['avachinsky', 'krai_koryak']);
  });

  it('без метки дальнего округа зоны живой строки не сужаются', async () => {
    await parser.saveEvent(sampleEvent({ ...HYDRO, affected_zones: ['avachinsky', 'northern'] }));
    await parser.saveEvent(sampleEvent({ ...HYDRO, source_id: 't.me/kbgsras/pg-test-far-3', affected_zones: ['avachinsky'] }));
    expect(await zonesOf()).toEqual(['avachinsky', 'northern']);
  });

  it('строка уже с меткой второй раз не переписывается', async () => {
    await parser.saveEvent(sampleEvent({ ...HYDRO, affected_zones: ['avachinsky', 'krai_koryak'] }));
    await parser.saveEvent(sampleEvent({ ...HYDRO, source_id: 't.me/kbgsras/pg-test-far-4', affected_zones: ['krai_koryak'] }));
    expect(await zonesOf()).toEqual(['avachinsky', 'krai_koryak']);
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

  // ── Основание дорожного закрытия (10.10, lib/safety/road-basis-queue) ──
  // Моки не видят двух вещей, на которых держится обещание: что GREATEST и
  // «только поверх пустого» сервер выполняет как задумано, и что CHECK
  // миграции 1212 не пустит основание без происхождения. Живёт в этом файле,
  // а не в своём: число pg-файлов держит размен «последовательно вместо
  // изоляции» (pg-tests-run-in-ci).
  describe('основание дорожного закрытия', () => {
    let channel: typeof import('@/lib/services/safety/road-channel');
    let queue: typeof import('@/lib/safety/road-basis-queue');

    beforeAll(async () => {
      channel = await import('@/lib/services/safety/road-channel');
      queue = await import('@/lib/safety/road-basis-queue');
    });

    beforeEach(async () => {
      await pool.query(`DELETE FROM external_alerts WHERE external_id LIKE 't.me/pravonarul/%'`);
    });

    /** Пост канала «час назад» с закрытием до момента `untilText`. */
    async function savePost(id: number, text: string) {
      const published = new Date(Date.now() - HOUR);
      const event = channel.classifyRoadChannelPost({
        id: `t.me/pravonarul/${id}`, url: `https://t.me/pravonarul/${id}`, text, datetime: published.toISOString(), photos: [],
      });
      if (!event) throw new Error('пост не классифицирован');
      expect(await parser.saveEvent(event)).toBe('inserted');
      const { rows } = await pool.query<{ expires_at: Date }>(`SELECT expires_at FROM external_alerts WHERE external_id = $1`, [event.source_id]);
      return { id: event.source_id, expiresAt: rows[0].expires_at };
    }

    it('запись из канала встаёт в очередь; найденное основание продлевает срок, но не сокращает', async () => {
      const a = await savePost(1, 'Октябрьскую косу закрыли для проезда');
      expect(await queue.pendingBasisChecks([a.id, 't.me/pravonarul/404'], pool as never)).toEqual(new Set([a.id]));

      const later = new Date(a.expiresAt.getTime() + 20 * HOUR);
      await queue.applyBasisReading(a.id, { outcome: 'found', title: 'Приказ КГКУ «Камчатуправтодор» от 08.10.2026 № 122', validUntil: later }, `https://${a.id}`, pool as never);
      const row = (await pool.query(`SELECT basis_title, basis_url, basis_origin, basis_check_outcome, expires_at FROM external_alerts WHERE external_id = $1`, [a.id])).rows[0];
      expect(row).toMatchObject({ basis_origin: 'image_ocr', basis_check_outcome: 'found', basis_url: `https://${a.id}` });
      expect(new Date(row.expires_at).getTime()).toBe(later.getTime());
      // Проверенный больше не в очереди.
      expect(await queue.pendingBasisChecks([a.id], pool as never)).toEqual(new Set());

      const b = await savePost(2, 'Закрыт проезд к перевалу из-за снега');
      const earlier = new Date(b.expiresAt.getTime() - 10 * HOUR);
      await queue.applyBasisReading(b.id, { outcome: 'found', title: 'Распоряжение X от 08.10.2026', validUntil: earlier }, `https://${b.id}`, pool as never);
      const kept = (await pool.query(`SELECT expires_at FROM external_alerts WHERE external_id = $1`, [b.id])).rows[0];
      expect(new Date(kept.expires_at).getTime()).toBe(b.expiresAt.getTime());
    });

    it('ручное основание автомат не трогает', async () => {
      const a = await savePost(3, 'Октябрьскую косу закрыли для проезда');
      await pool.query(`UPDATE external_alerts SET basis_title = 'Приказ от 08.10.2026 № 122 (вписан вручную)', basis_origin = 'manual' WHERE external_id = $1`, [a.id]);
      expect(await queue.pendingBasisChecks([a.id], pool as never)).toEqual(new Set());
      const changed = await queue.applyBasisReading(a.id, { outcome: 'found', title: 'Другое прочтение', validUntil: null }, `https://${a.id}`, pool as never);
      expect(changed).toBe(false);
      const row = (await pool.query(`SELECT basis_title, basis_origin FROM external_alerts WHERE external_id = $1`, [a.id])).rows[0];
      expect(row).toEqual({ basis_title: 'Приказ от 08.10.2026 № 122 (вписан вручную)', basis_origin: 'manual' });
    });

    it('зрение не ответило — не «документа нет»: повтор через час', async () => {
      const a = await savePost(4, 'Октябрьскую косу закрыли для проезда');
      await queue.applyBasisReading(a.id, { outcome: 'unavailable', reason: 'qwen 503' }, `https://${a.id}`, pool as never);
      expect(await queue.pendingBasisChecks([a.id], pool as never)).toEqual(new Set());
      await pool.query(`UPDATE external_alerts SET basis_checked_at = NOW() - INTERVAL '2 hours' WHERE external_id = $1`, [a.id]);
      expect(await queue.pendingBasisChecks([a.id], pool as never)).toEqual(new Set([a.id]));
      // «Не документ» — окончательно: снимок второй раз не смотрим.
      await queue.applyBasisReading(a.id, { outcome: 'no_document', reason: 'дорога на фото' }, `https://${a.id}`, pool as never);
      await pool.query(`UPDATE external_alerts SET basis_checked_at = NOW() - INTERVAL '2 hours' WHERE external_id = $1`, [a.id]);
      expect(await queue.pendingBasisChecks([a.id], pool as never)).toEqual(new Set());
    });

    it('CHECK миграции 1212: основание без происхождения, чужое происхождение и исход без отметки не пройдут', async () => {
      const a = await savePost(5, 'Октябрьскую косу закрыли для проезда');
      for (const sql of [
        `UPDATE external_alerts SET basis_title = 'Приказ без происхождения' WHERE external_id = $1`,
        `UPDATE external_alerts SET basis_title = 'Приказ X', basis_origin = 'model' WHERE external_id = $1`,
        `UPDATE external_alerts SET basis_check_outcome = 'found' WHERE external_id = $1`,
      ]) {
        await expect(pool.query(sql, [a.id])).rejects.toMatchObject({ code: '23514' });
      }
    });
  });

  // ── Дата последней сводки и парки закрытия (06.11, миграция 1394) ──────
  // Повтор сводки — подтверждение: «сообщение от», отсчёт прохода открытий и
  // вывод «не знаю» считаются от последней публикации. Повтор закрытия после
  // сводки об открытии возвращает снятый ею парк — но только более поздний
  // повтор, а не тот же пост, перечитанный через пять минут. Здесь — настоящий
  // saveEvent и настоящий проход applyParkReopenings на одной базе.
  describe('последняя сводка и парки закрытия', () => {
    const DAY = 24 * HOUR;
    const SEASONAL = 'Маршруты природных парков «Налычево» и «Ключевской» закрыты на период межсезонья';
    const closure = (n: number, publishedAt: Date): SeismicEvent => ({
      source_id: `visitkamchatka/2026-11-0${n}/tpgpark${n}`,
      source_url: `https://t.me/s/visitkamchatka41/${n}`,
      published_at: publishedAt,
      alert_type: 'park_closure',
      severity: 2,
      title: SEASONAL,
      description: '',
      affected_zones: [],
      affected_parks: ['nalychevo', 'klyuchevskoy'],
      expires_hours: 21 * 24,
    });
    const row = async () => (await pool.query<{ parks: string[]; same: boolean; last: Date; live: boolean; ended_by: string | null }>(
      `SELECT affected_parks AS parks, last_published_at = created_at AS same, last_published_at AS last,
              expires_at > (NOW() AT TIME ZONE 'UTC') AS live, ended_by
         FROM external_alerts WHERE external_id = 'visitkamchatka/2026-11-01/tpgpark1'`,
    )).rows[0];

    beforeEach(async () => {
      await pool.query(`DELETE FROM external_alerts WHERE external_id LIKE 'visitkamchatka/2026-11-0_/tpgpark%' OR external_id LIKE 'visitkamchatka/%/opgpark%'`);
    });

    it('вставка пишет дату последней сводки = публикации; повтор позже двигает её вперёд, раньше — нет', async () => {
      const t0 = new Date(Date.now() - 3 * DAY);
      expect(await parser.saveEvent(closure(1, t0))).toBe('inserted');
      expect((await row()).same).toBe(true);
      // Повтор раньше (перепечатка старого поста) дату назад не уводит.
      expect(await parser.saveEvent(closure(2, new Date(t0.getTime() - DAY)))).toBe('skipped');
      expect((await row()).same).toBe(true);
      const t2 = new Date(t0.getTime() + DAY);
      expect(await parser.saveEvent(closure(3, t2))).toBe('skipped');
      const r = await row();
      expect(r.same).toBe(false);
      // Стенное UTC: колонка без пояса, как created_at.
      const wall = (await pool.query<{ ok: boolean }>(
        `SELECT last_published_at = $1::timestamp AS ok FROM external_alerts WHERE external_id = 'visitkamchatka/2026-11-01/tpgpark1'`, [t2],
      )).rows[0].ok;
      expect(wall).toBe(true);
    });

    it('открытие снимает парк; тот же пост закрытия его не возвращает; более поздняя сводка — возвращает, и проход её не трогает', async () => {
      const { applyParkReopenings } = await import('@/lib/services/safety/park-reopening');
      const q = async <T,>(sql: string, params: unknown[]) => (await pool.query(sql, params)) as unknown as { rows: T[] };
      const events: Array<{ decisionReason?: string; details?: Record<string, unknown> }> = [];
      const record = async (e: { decisionReason?: string; details?: Record<string, unknown> }) => { events.push(e); };
      const t0 = new Date(Date.now() - 3 * DAY);
      await parser.saveEvent(closure(1, t0));
      // Сводка об открытии Налычево сутками позже — рождена истёкшей.
      const opening: SeismicEvent = {
        source_id: 'visitkamchatka/2026-11-04/opgpark1',
        source_url: 'https://t.me/s/visitkamchatka41/9',
        published_at: new Date(t0.getTime() + DAY),
        alert_type: 'park_reopening', severity: 0,
        title: 'Маршруты парка «Налычево» вновь открыты для посещения', description: '',
        affected_zones: [], affected_parks: ['nalychevo'], expires_hours: 0,
      };
      expect(await parser.saveEvent(opening)).toBe('inserted');
      const born = (await pool.query<{ dead: boolean }>(
        `SELECT expires_at <= (NOW() AT TIME ZONE 'UTC') AS dead FROM external_alerts WHERE external_id = $1`, [opening.source_id],
      )).rows[0].dead;
      expect(born, 'открытие рождается истёкшим').toBe(true);

      const first = await applyParkReopenings(q, record);
      expect(first.narrowed).toBe(1);
      expect((await row()).parks).toEqual(['klyuchevskoy']);
      expect(events[0].details).toMatchObject({ prior_parks: ['nalychevo', 'klyuchevskoy'], parks: ['klyuchevskoy'], opened_parks: ['nalychevo'] });

      // Тот же пост перечитан — парк не возвращается, проход идемпотентен.
      expect(await parser.saveEvent(closure(1, t0))).toBe('skipped');
      expect((await row()).parks).toEqual(['klyuchevskoy']);
      expect((await applyParkReopenings(q, record)).narrowed + (await applyParkReopenings(q, record)).ended).toBe(0);

      // Новая сводка о закрытии после открытия — парк вернулся в конец списка.
      expect(await parser.saveEvent(closure(5, new Date(t0.getTime() + 2 * DAY)))).toBe('skipped');
      expect((await row()).parks).toEqual(['klyuchevskoy', 'nalychevo']);
      const reparked = (await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM safety_decision_events
          WHERE event_type = 'dedup_skipped' AND details ? 'reparked_from'`,
      )).rows[0].n;
      expect(reparked).toBeGreaterThan(0);
      // Закрытие теперь опубликовано позже открытия — проход его не трогает.
      const again = await applyParkReopenings(q, record);
      expect(again.narrowed + again.ended).toBe(0);
      expect((await row()).parks).toEqual(['klyuchevskoy', 'nalychevo']);
    });

    it('погашенное открытием дедуп не воскрешает: повтор после открытия — новая строка, а не продление', async () => {
      const t0 = new Date(Date.now() - 3 * DAY);
      await parser.saveEvent(closure(1, t0));
      await pool.query(
        `UPDATE external_alerts SET expires_at = (NOW() AT TIME ZONE 'UTC'), ended_by = 'reopening'
          WHERE external_id = 'visitkamchatka/2026-11-01/tpgpark1'`,
      );
      expect(await parser.saveEvent(closure(6, new Date(t0.getTime() + 2 * DAY)))).toBe('inserted');
      const r = await row();
      expect(r.live).toBe(false);
      expect(r.ended_by).toBe('reopening');
    });

    it('пост MAX без даты: повтор не двигает дату последней сводки, а открытие из MAX не пишется вовсе (ревью 06.11)', async () => {
      // Раннер шлёт посты MAX без даты, и ingestMaxItems подставляет «сейчас».
      // Такая дата не подтверждает сводку: иначе «сообщение от» называло бы
      // днём поста день нашего чтения, а открытие гасило бы более позднее
      // закрытие датой чтения.
      await pool.query(`DELETE FROM external_alerts WHERE external_id LIKE 'max_mchs/%'`);
      const text = 'Посещение маршрутов природного парка «Налычево» приостановлено на период межсезонья.';
      const first = await parser.ingestMaxItems([{ id: 'max/pg-closure', text }]);
      expect(first.events.map((e) => e.alert_type)).toEqual(['park_closure']);
      expect(first.inserted).toBe(1);
      const lastOf = async () => (await pool.query<{ last: string }>(
        `SELECT last_published_at::text AS last FROM external_alerts WHERE external_id LIKE 'max_mchs/%' AND alert_type = 'park_closure'`,
      )).rows.map((r) => r.last);
      const before = await lastOf();
      expect(before).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 20));
      await parser.ingestMaxItems([{ id: 'max/pg-closure', text }]);
      expect(await lastOf()).toEqual(before);

      const opening = await parser.ingestMaxItems([{ id: 'max/pg-open', text: 'Маршруты природного парка «Налычево» вновь открыты для посещения туристов.' }]);
      expect(opening.events.some((e) => e.alert_type === 'park_reopening')).toBe(false);
      const rows = (await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM external_alerts WHERE external_id LIKE 'max_mchs/%' AND alert_type = 'park_reopening'`,
      )).rows[0].n;
      expect(rows).toBe(0);
      await pool.query(`DELETE FROM external_alerts WHERE external_id LIKE 'max_mchs/%'`);
    });

    it('CHECK миграции 1394: ended_by — только admin, reopening, legacy', async () => {
      await parser.saveEvent(closure(1, new Date(Date.now() - DAY)));
      await expect(pool.query(
        `UPDATE external_alerts SET ended_by = 'expired' WHERE external_id = 'visitkamchatka/2026-11-01/tpgpark1'`,
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});
