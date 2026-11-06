/**
 * Кого накрывает предупреждение — на настоящем PostgreSQL.
 *
 * ── Почему этот файл существует ─────────────────────────────────────────
 *
 * Замер владельца с прода (дайджест 27.09, MCP платформы):
 *
 *   Ключевская сопка [КРАСНЫЙ]
 *   активный алерт: «Извержение вулкана Шивелуч — высота 5.0 км»
 *   KVERT по Ключевскому при этом ЖЁЛТЫЙ, сейсмичность фоновая
 *
 *   «Вилючинский перевал: проезд по пропускам» — на Курильском озере,
 *   в Быстринском парке, на Безымянном, в Налычево, на Голубых озёрах
 *
 * Механизм у обоих один: предикат сопоставления спрашивал координату ТОЛЬКО
 * у двух родов события (пожар, перекрытая дорога), а всё остальное — включая
 * извержение — раскладывал ЗОНОЙ. Северная зона это Шивелуч, Ключевской,
 * Безымянный и Толбачик разом. Дорожный алерт, чьё имя не разрешилось в точку
 * каталога, оставался без координаты и падал в ту же зональную ветку.
 *
 * Предикат жил внутри крон-роута, и проверить его можно было только вместе с
 * походами за сводками — поэтому его не проверял никто. Теперь он в
 * `lib/services/safety/alert-place-scope.ts` и ИСПОЛНЯЕТСЯ здесь: форму SQL
 * судит сервер, а не чтение (§4.0, «судить статикой запрещено»).
 *
 * Схема — тот же путь, что у деплоя: baseline прода плюс все миграции новее.
 * Своя база `alert_scope_test`. Без KERNEL_PG_TEST_URL файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { ALERT_MATCH_SQL, ALERT_ZONAL_ONLY_SQL } from '@/lib/services/safety/alert-place-scope';
import { TOURIST_BAN_SQL, BAN_AUDIENCE, BAN_VERB } from '@/lib/services/safety/tourist-ban';
import { collectRouteSignals, type QueryFn } from '@/lib/routes/collect-signals';
import { ACTIVE_ZONE_ALERTS_SQL, UNDATED_ALERT_HORIZON_DAYS } from '@/lib/safety/alerts';
import { KRAI_COMMANDER_ZONE, KRAI_KORYAK_ZONE } from '@/lib/safety/krai-far';
import { KURIL_NORTH_ZONE } from '@/lib/safety/kuril-north';
import { MARINE_ALERT_SQL, isMarineAlert } from '@/lib/safety/marine-alert';
import { classifyMchsItem, classifyMessage, mchs_zones } from '@/lib/services/safety/seismic-parser';
import { meteoalertEvents } from '@/lib/services/safety/meteoalert';
import { ZONE_CENSUS_SQL, summarizeZoneCensus, zoneProbes, type ZoneCensusRow } from '@/lib/places/zone-census';
import { readFileSync } from 'node:fs';
import { holdParkClosures } from '@/lib/services/safety/park-closure-hold';
import { applyParkReopenings, markParkStatusUnknown, rejectParkReopening } from '@/lib/services/safety/park-reopening';
import { PARK_STATUS_UNKNOWN_SQL } from '@/lib/services/safety/alert-place-scope';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import { VOLCANO_STALE_DAYS } from '@/lib/services/safety/kvert-vona';
import { KFEGS_MAX_AGE_DAYS } from '@/lib/services/safety/volcano-scales';
import { sameParksParam, sameParksSql } from '@/lib/services/safety/push-same-kind';
import { PARK_CLOSURE_HOLD_HOURS } from '@/lib/safety/park-closure';
import { createTestDatabase } from '../helpers/pg-schema';
import { applyPlanParkStatus, loadPlanParkAlerts, PARK_STATUS_UNREAD_NOTE } from '@/lib/planner/park-status';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[alert-place-scope.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'alert_scope_test';

/** Настоящие координаты: между конусами ~75 км, то есть больше порога 25. */
const SHIVELUCH = { id: 'place-shiveluch-test', ark: 'b0000000-0000-4000-8000-000000000001', lat: 56.653, lng: 161.360 };
const KLYUCHEVSKOY = { id: 'place-klyuchevskoy-test', ark: 'b0000000-0000-4000-8000-000000000002', lat: 56.056, lng: 160.642 };
/** Место у подножия Шивелуча: ближе 25 км, привязки в таблице нет. */
const NEAR_SHIVELUCH = { id: 'place-near-shiveluch-test', ark: 'b0000000-0000-4000-8000-000000000003', lat: 56.700, lng: 161.300 };
/** Место в той же зоне, но далеко и без связи с вулканом. */
const FAR_NORTH = { id: 'place-far-north-test', ark: 'b0000000-0000-4000-8000-000000000004', lat: 57.800, lng: 160.000 };
/** Привязанное к Шивелучу поимённо (place_volcano_links), но за 120 км. */
const LINKED_FAR = { id: 'place-linked-far-test', ark: 'b0000000-0000-4000-8000-000000000005', lat: 55.600, lng: 161.900 };

/**
 * Закрытие парка (#2133). Все — в зоне avachinsky: зона не должна решать,
 * решает парк. Город в той же зоне — контроль «зона ≠ парк».
 */
const PARK_NAMED = { id: 'Природный парк Налычево (тест)', ark: 'c0000000-0000-4000-8000-000000000001', lat: 53.400, lng: 158.900 };
const ON_PARK_ROUTE = { id: 'Таловские источники (тест)', ark: 'c0000000-0000-4000-8000-000000000002', lat: 53.350, lng: 158.950 };
const NEAR_PARK_ROUTE = { id: 'Музей у тропы (тест)', ark: 'c0000000-0000-4000-8000-000000000003', lat: 53.100, lng: 158.700 };
const CITY = { id: 'Городская набережная (тест)', ark: 'c0000000-0000-4000-8000-000000000004', lat: 53.020, lng: 158.650 };
/**
 * Остров Беринга (#2293). Зона NULL: место накрывает только метка Командоров,
 * зональные счёты северной зоны выше от неё не меняются.
 */
const COMMANDER = { id: 'Никольское (тест)', ark: 'c0000000-0000-4000-8000-000000000005', lat: 55.200, lng: 165.990 };
const PARK_ROUTE_ID = 'd0000000-0000-4000-8000-000000000001';

withPg('кого накрывает предупреждение', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    // Схема прода — копия шаблона (baseline + миграции новее границы снимка):
    // tests/helpers/pg-schema.ts, аудит 15.10, P2-10.
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    // Мир теста — только его места. Миграции заводят и настоящие (Кроноцкий
    // заповедник, Каньон на Шивелуче…), а 1293 даёт строку реалтайма каждому
    // видимому месту — без чистки они попадали бы в счёт охвата.
    await pool.query(`DELETE FROM location_real_time_status`);

    for (const [p, type, zone] of [
      [SHIVELUCH, 'volcano', 'northern'],
      [KLYUCHEVSKOY, 'volcano', 'northern'],
      [NEAR_SHIVELUCH, 'mountain', 'northern'],
      [FAR_NORTH, 'lake', 'northern'],
      [LINKED_FAR, 'mountain', 'northern'],
    ] as Array<[typeof SHIVELUCH, string, string]>) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $1, $2, $3, $4, $5, $6, TRUE)`,
        [p.id, p.lat, p.lng, p.ark, type, zone],
      );
      await pool.query(
        `INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`,
        [p.ark],
      );
    }
    await pool.query(
      `INSERT INTO place_volcano_links (place_id, volcano_place_id, reason)
       VALUES ($1, $2, 'тест: маршрут поимённо привязан к вулкану')`,
      [LINKED_FAR.id, SHIVELUCH.id],
    );

    // Парк: baseline — схема без строк справочника, а 712 старше baseline.
    await pool.query(
      `INSERT INTO parks (slug, display_name, search_term)
       VALUES ('nalychevo', 'Природный парк «Налычево»', 'Налычево')
       ON CONFLICT (slug) DO NOTHING`,
    );
    for (const p of [PARK_NAMED, ON_PARK_ROUTE, NEAR_PARK_ROUTE, CITY]) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $1, $2, $3, $4, 'hot_spring', 'avachinsky', TRUE)`,
        [p.id, p.lat, p.lng, p.ark],
      );
      await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [p.ark]);
    }
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
       VALUES ($1, $1, $2, $3, $4, 'settlement', NULL, TRUE)`,
      [COMMANDER.id, COMMANDER.lat, COMMANDER.lng, COMMANDER.ark],
    );
    await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [COMMANDER.ark]);
    // park_name — свободным текстом, как его записал импорт (миграция 712).
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, park_name, zone, is_visible)
       VALUES ($1, 'trekking', 'Тропа к Таловским источникам (тест)', 'Природный парк "Налычево"', 'avachinsky', TRUE)`,
      [PARK_ROUTE_ID],
    );
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
         ($1, $2, 0, 'waypoint'),
         ($1, $3, 1, 'nearby')`,
      [PARK_ROUTE_ID, ON_PARK_ROUTE.id, NEAR_PARK_ROUTE.id],
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`).catch(() => undefined);
    await bootstrap.end();
  });

  /** Кого накрыл алерт — тем же предикатом, каким это делает крон. */
  async function coveredBy(alertId: string): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT p.name
         FROM location_real_time_status lrs
         JOIN places p ON p.ark_id = lrs.agent_route_id
         LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
         JOIN external_alerts ea
           ON (ea.expires_at IS NULL OR ea.expires_at > NOW())
          AND (${ALERT_MATCH_SQL})
        WHERE ea.id::text = $1
        ORDER BY p.name`,
      [alertId],
    );
    return rows.map((r) => r.name);
  }

  async function insertAlert(fields: {
    type: string; title: string; zones: string[];
    lat?: number; lng?: number; volcanoName?: string; volcanoArk?: string;
    parks?: string[] | null; magnitude?: number;
    /** Охват вулканической тревоги (1301); не задан — по умолчанию колонки, ring. */
    volcanoScope?: 'ring' | 'named';
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      // external_id отдельным параметром, а не `$2 || '-' || ...`: у параметра
      // в конкатенации нет якоря типа, и Postgres отвечает 42P08
      // «inconsistent types deduced» — первая редакция этого теста на нём и
      // упала, ровно как описано в CLAUDE.md про запрос, который не
      // выполнялся никогда.
      `INSERT INTO external_alerts
         (alert_type, severity, title, description, affected_zones, created_at, expires_at,
          source_url, external_id, lat, lng, volcano_name, volcano_ark_id, affected_parks, magnitude,
          volcano_scope)
       VALUES ($1, 2, $2, $9, $3, NOW(), NOW() + INTERVAL '1 day',
               'https://example.test', $8, $4, $5, $6, $7, $10, $11,
               COALESCE($12::text, 'ring'))
       RETURNING id::text AS id`,
      [fields.type, fields.title, fields.zones, fields.lat ?? null, fields.lng ?? null,
        fields.volcanoName ?? null, fields.volcanoArk ?? null,
        `${fields.type}-${Math.random().toString(36).slice(2)}`,
        // Заголовок и описание — РАЗНЫМИ параметрами: title это varchar, а
        // description text, и один $2 на оба даёт тот же 42P08.
        fields.title,
        fields.parks ?? null,
        fields.magnitude ?? null,
        fields.volcanoScope ?? null],
    );
    return rows[0].id;
  }

  /** Пришёл ли алерт к месту только по зоне — тем же предикатом, что крон красит. */
  async function zonalFor(alertId: string, placeId: string): Promise<boolean | null> {
    const { rows } = await pool.query<{ zonal: boolean }>(
      `SELECT COALESCE(${ALERT_ZONAL_ONLY_SQL}, false) AS zonal
         FROM location_real_time_status lrs
         JOIN places p ON p.ark_id = lrs.agent_route_id
         LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
         JOIN external_alerts ea
           ON (ea.expires_at IS NULL OR ea.expires_at > NOW())
          AND (${ALERT_MATCH_SQL})
        WHERE ea.id::text = $1 AND p.id = $2`,
      [alertId, placeId],
    );
    return rows[0]?.zonal ?? null;
  }

  // ── Зональный уровень 2 — жёлтый, а не красный (решение владельца 03.10, #2195) ──
  it('экстренное о дожде по зоне пришло к месту зоной — крон даст жёлтый', async () => {
    const id = await insertAlert({ type: 'weather', title: 'Экстренное предупреждение (сильный дождь, тест)', zones: ['avachinsky'] });
    expect(await coveredBy(id)).toContain(CITY.id);
    expect(await zonalFor(id, CITY.id)).toBe(true);
  });

  it('сильный близкий толчок привязан силой сотрясения — не зональный, красный остаётся', async () => {
    const id = await insertAlert({
      type: 'earthquake', title: 'Землетрясение ML 6.5 — 20 км (тест зональности)', zones: ['avachinsky'],
      lat: 52.9, lng: 158.85, magnitude: 6.5,
    });
    expect(await zonalFor(id, CITY.id)).toBe(false);
  });

  it('толчок без координаты пришёл зоной — зональный', async () => {
    const id = await insertAlert({ type: 'earthquake', title: 'Землетрясение ML 5 (тест зональности, без координат)', zones: ['avachinsky'], magnitude: 5 });
    expect(await zonalFor(id, CITY.id)).toBe(true);
  });

  // ── Прямой запрет туристам не понижается до жёлтого (поправка 03.10) ──────
  it('сервер признаёт запретом то же, что классификатор, — на формулировках МЧС', async () => {
    const texts = [
      'Тургруппам и охотникам воздержаться от выхода на маршруты',
      'Экстренное предупреждение на 3 октября 2026 г. (сильный дождь)',
      'Выход тургрупп не рекомендуется',
      'Сплавы на рафтах по рекам зоны предупреждения необходимо исключить',
      'Не исключается сход лавин; туристам быть внимательнее',
      'Просьба к тургруппам зарегистрироваться в МЧС',
    ];
    for (const t of texts) {
      const { rows } = await pool.query<{ ban: boolean }>(
        `SELECT ${TOURIST_BAN_SQL} AS ban FROM (SELECT $1::text AS title, NULL::text AS description) ea`,
        [t],
      );
      const js = BAN_AUDIENCE.test(t.toLowerCase()) && BAN_VERB.test(t.toLowerCase());
      expect(rows[0].ban, t).toBe(js);
    }
  });

  it('зональный запрет туристам — не зональный для цвета: место остаётся красным', async () => {
    const id = await insertAlert({ type: 'weather', title: 'Тургруппам воздержаться от выхода на маршруты (тест)', zones: ['avachinsky'] });
    const { rows } = await pool.query<{ zonal: boolean }>(
      `SELECT COALESCE(${ALERT_ZONAL_ONLY_SQL} AND NOT ${TOURIST_BAN_SQL}, false) AS zonal
         FROM location_real_time_status lrs
         JOIN places p ON p.ark_id = lrs.agent_route_id
         LEFT JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
         JOIN external_alerts ea ON (${ALERT_MATCH_SQL})
        WHERE ea.id::text = $1 AND p.id = $2`,
      [id, CITY.id],
    );
    expect(rows[0]?.zonal).toBe(false);
  });

  // ── Землетрясение: сила сотрясения, а не зона (03.10, #2195) ──────────────
  it('ML 6.2 в океане за 182 км город не красит (было: «Сегодня сюда — нет» на Никольской сопке)', async () => {
    // Эпицентр 51.566/159.674 — второй толчок поста МЧС 03.10, 182 км от ПК.
    const id = await insertAlert({
      type: 'earthquake', title: 'Землетрясение ML 6.2 — 182 км (тест)', zones: ['avachinsky'],
      lat: 51.566, lng: 159.674, magnitude: 6.2,
    });
    expect(await coveredBy(id)).not.toContain(CITY.id);
  });

  it('сильный близкий толчок город красит — сигнал не погашен', async () => {
    const id = await insertAlert({
      type: 'earthquake', title: 'Землетрясение ML 6.5 — 20 км (тест)', zones: ['avachinsky'],
      lat: 52.9, lng: 158.85, magnitude: 6.5,
    });
    expect(await coveredBy(id)).toContain(CITY.id);
  });

  it('толчок без координаты судится зоной, как раньше — «не измерили» ≠ «далеко»', async () => {
    const id = await insertAlert({
      type: 'earthquake', title: 'Землетрясение ML 5 (тест, без координат)', zones: ['avachinsky'], magnitude: 5,
    });
    expect(await coveredBy(id)).toContain(CITY.id);
  });

  it('извержение без привязки к вулкану не красит НИКОГО (было: всю северную зону)', async () => {
    const id = await insertAlert({
      type: 'volcanic_eruption',
      title: 'Извержение вулкана Шивелуч — высота 5.0 км',
      zones: ['northern'],
      volcanoName: 'Шивелуч',
    });
    // Ровно этот случай давал Ключевскому красный: имя вулкана было, привязки
    // не было, и зона накрывала весь север.
    expect(await coveredBy(id)).toEqual([]);
  });

  it('привязанное извержение накрывает свой вулкан и то, что с ним связано, — но не соседний вулкан', async () => {
    const id = await insertAlert({
      type: 'volcanic_eruption',
      title: 'Извержение вулкана Шивелуч — высота 5.0 км',
      zones: ['northern'],
      volcanoName: 'Шивелуч',
      volcanoArk: SHIVELUCH.ark,
    });
    const covered = await coveredBy(id);
    // Сам вулкан; место ближе 25 км; место, привязанное поимённо (1029).
    expect(covered).toContain(SHIVELUCH.id);
    expect(covered).toContain(NEAR_SHIVELUCH.id);
    expect(covered).toContain(LINKED_FAR.id);
    // Ключевской — другой вулкан в 75 км: он и был ложным красным.
    expect(covered).not.toContain(KLYUCHEVSKOY.id);
    // Дальнее место той же зоны без связи с вулканом.
    expect(covered).not.toContain(FAR_NORTH.id);
  });

  /**
   * Запрет подходить к вулкану — только сам вулкан и места, привязанные к нему
   * поимённо (слово владельца 16.10, миграция 1301). Кольцо 25 км остаётся
   * извержению: проба 144 — кольцо запрета Мутновского дошло до мыса на берегу
   * в 24,6 км, кольцо Крашенинникова — до Долины гейзеров в 19,8 км.
   */
  describe('запрет подходить к вулкану: охват named (16.10)', () => {
    const ROUTE_THROUGH = 'd0000000-0000-4000-8000-0000000000b1';
    const ROUTE_LINKED = 'd0000000-0000-4000-8000-0000000000b2';
    const ROUTE_NEAR = 'd0000000-0000-4000-8000-0000000000b3';
    const ROUTE_NEARBY_LINK = 'd0000000-0000-4000-8000-0000000000b4';
    const q: QueryFn = (sql, params) => pool.query(sql, params) as never;
    const titlesOf = async (routeId: string): Promise<string[]> => {
      const s = await collectRouteSignals(routeId, { query: q, month: 10 });
      expect(s.alerts, 'запрос предупреждений маршрута не выполнился').not.toBeNull();
      return s.alerts!.map((a) => a.title);
    };

    beforeAll(async () => {
      // Без своей координаты: опора маршрута — только путевая точка.
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible) VALUES
           ($1, 'trekking', 'Восхождение к подножию Шивелуча (тест)', 'northern', TRUE),
           ($2, 'trekking', 'Тропа через привязанное место (тест)', 'northern', TRUE)`,
        [ROUTE_THROUGH, ROUTE_LINKED],
      );
      // Своя координата в 6 км от вулкана, путевой точки у вулкана нет.
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, lat, lng, is_visible)
         VALUES ($1, 'trekking', 'Маршрут рядом с Шивелучем (тест)', 'northern', $2, $3, TRUE)`,
        [ROUTE_NEAR, NEAR_SHIVELUCH.lat, NEAR_SHIVELUCH.lng],
      );
      // Вулкан у маршрута — связью «рядом», опора маршрута за 150 км.
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, lat, lng, is_visible)
         VALUES ($1, 'trekking', 'Маршрут с вулканом «рядом» (тест)', 'northern', $2, $3, TRUE)`,
        [ROUTE_NEARBY_LINK, FAR_NORTH.lat, FAR_NORTH.lng],
      );
      await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES
           ($1, $4, 0, 'waypoint'),
           ($2, $5, 0, 'waypoint'),
           ($3, $4, 0, 'nearby')`,
        [ROUTE_THROUGH, ROUTE_LINKED, ROUTE_NEARBY_LINK, SHIVELUCH.id, LINKED_FAR.id],
      );
    });

    it('место: сам вулкан и привязанное поимённо — да; ближе 25 км без связи — нет', async () => {
      const id = await insertAlert({
        type: 'volcanic_eruption',
        title: 'Вулкан Шивелуч: не ближе 10 км к вершине (тест)',
        zones: ['northern'],
        volcanoName: 'Шивелуч',
        volcanoArk: SHIVELUCH.ark,
        volcanoScope: 'named',
      });
      const covered = await coveredBy(id);
      expect(covered).toContain(SHIVELUCH.id);
      // Привязано к Шивелучу поимённо (1029), хотя лежит за 120 км.
      expect(covered).toContain(LINKED_FAR.id);
      // Ближе 25 км, но связи нет: кольцо — правило извержения, не запрета.
      expect(covered).not.toContain(NEAR_SHIVELUCH.id);
      expect(covered).not.toContain(KLYUCHEVSKOY.id);
      expect(covered).not.toContain(FAR_NORTH.id);
    });

    it('маршрут: через вулкан или привязанное место — да; рядом или связью «рядом» — нет', async () => {
      const t = 'Вулкан Шивелуч: приближаться не рекомендуется (тест маршрута)';
      await insertAlert({
        type: 'volcanic_eruption', title: t, zones: ['northern'],
        volcanoName: 'Шивелуч', volcanoArk: SHIVELUCH.ark, volcanoScope: 'named',
      });
      expect(await titlesOf(ROUTE_THROUGH)).toContain(t);
      expect(await titlesOf(ROUTE_LINKED)).toContain(t);
      expect(await titlesOf(ROUTE_NEAR)).not.toContain(t);
      expect(await titlesOf(ROUTE_NEARBY_LINK)).not.toContain(t);
    });

    it('извержение (охват по умолчанию) маршрут рядом по-прежнему накрывает кольцом', async () => {
      const t = 'Извержение вулкана Шивелуч — высота 6.0 км (тест маршрута)';
      await insertAlert({
        type: 'volcanic_eruption', title: t, zones: ['northern'],
        volcanoName: 'Шивелуч', volcanoArk: SHIVELUCH.ark,
      });
      expect(await titlesOf(ROUTE_NEAR)).toContain(t);
      expect(await titlesOf(ROUTE_THROUGH)).toContain(t);
    });

    it('охват — только ring или named: опечатку база не примет', async () => {
      await expect(pool.query(
        `INSERT INTO external_alerts (alert_type, title, volcano_scope) VALUES ('volcanic_eruption', 'тест охвата', 'radius')`,
      )).rejects.toMatchObject({ code: '23514' });
    });

    it('1301: вулканические записи сводки 1298 — named, Крашенинникова — уровень 2, прочие — ring', async () => {
      const { rows } = await pool.query<{ external_id: string; severity: number; volcano_scope: string }>(
        `SELECT external_id, severity::int AS severity, volcano_scope
           FROM external_alerts
          WHERE external_id LIKE 'manual-mintur-2026-10-16-%'
          ORDER BY external_id`,
      );
      const by = new Map(rows.map((r) => [r.external_id.replace('manual-mintur-2026-10-16-', ''), r]));
      for (const v of ['mutnovsky', 'bezymianny', 'klyuchevskoy', 'krasheninnikov', 'shiveluch']) {
        expect(by.get(v)?.volcano_scope, v).toBe('named');
      }
      expect(by.get('krasheninnikov')?.severity).toBe(2);
      expect(by.get('shiveluch')?.severity).toBe(1);
      // Дороги и парк — не вулканы: их охват не тронут.
      expect(by.get('klyuchevskoy-park')?.volcano_scope).toBe('ring');
      expect(by.get('levashov-cape')?.volcano_scope).toBe('ring');
    });
  });

  it('дорожный алерт без координаты не красит места (решение владельца 27.09)', async () => {
    const id = await insertAlert({
      type: 'road_closure',
      title: 'Вилючинский перевал: проезд по пропускам',
      zones: ['northern'],
    });
    expect(await coveredBy(id)).toEqual([]);
  });

  it('дорожный алерт с координатой накрывает только то, что ближе 30 км', async () => {
    const id = await insertAlert({
      type: 'road_closure',
      title: 'Дорога к подножию: движение закрыто',
      zones: ['northern'],
      lat: NEAR_SHIVELUCH.lat,
      lng: NEAR_SHIVELUCH.lng,
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(NEAR_SHIVELUCH.id);
    expect(covered).toContain(SHIVELUCH.id);
    expect(covered).not.toContain(KLYUCHEVSKOY.id);
    expect(covered).not.toContain(FAR_NORTH.id);
  });

  it('землетрясение по-прежнему судится зоной: сузить его нечем, и гадать опаснее', async () => {
    // Осознанное НЕсужение (§4.0): расстояние, на котором землетрясение
    // перестаёт иметь значение, зависит от магнитуды и глубины, и такого
    // числа у нас нет. Придуманный радиус здесь ГАСИЛ БЫ настоящий сигнал.
    const id = await insertAlert({
      type: 'earthquake',
      title: 'Землетрясение M5.4, глубина 60 км',
      zones: ['northern'],
      lat: 56.0,
      lng: 161.0,
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(FAR_NORTH.id);
    expect(covered.length).toBe(5);
  });

  it('событие без зон не красит никого — правило 17.09 не сломано', async () => {
    const id = await insertAlert({
      type: 'flood',
      title: 'Подтопление придомовых территорий',
      zones: [],
    });
    expect(await coveredBy(id)).toEqual([]);
  });

  it('«южная половина края» — места южнее северной окраины Петропавловска, не север и не Налычево (04.10)', async () => {
    const id = await insertAlert({
      type: 'flood',
      title: 'Прогнозируется подъем уровней воды на реках южной половины края',
      zones: ['krai_south'],
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(CITY.id);            // 53.02 — город
    expect(covered).toContain(NEAR_PARK_ROUTE.id); // 53.10 — граница включительно
    expect(covered).not.toContain(PARK_NAMED.id);  // 53.40 — Налычево
    expect(covered).not.toContain(ON_PARK_ROUTE.id);
    expect(covered).not.toContain(SHIVELUCH.id);
    expect(covered).not.toContain(KLYUCHEVSKOY.id);
  });

  // ── Дальние округа — по координатам места (решение владельца 09.10, #2293) ──
  it('Корякский округ — места севернее 57°, не Шивелуч и не Ключевская', async () => {
    const id = await insertAlert({
      type: 'flood', title: 'Подъём воды на реках Пенжинского и Олюторского районов (тест)', zones: [KRAI_KORYAK_ZONE],
    });
    expect(await coveredBy(id)).toEqual([FAR_NORTH.id]);
  });

  it('Командоры — только острова, не материк и не северная зона', async () => {
    const id = await insertAlert({ type: 'weather', title: 'Сильный ветер в Алеутском округе (тест)', zones: [KRAI_COMMANDER_ZONE] });
    expect(await coveredBy(id)).toEqual([COMMANDER.id]);
  });

  // 15.10: район места не решает, дойдёт ли тревога до острова. У Арки
  // Стеллера с районом «commander» после 1288 — ни одной тревоги, у Бакланьих
  // камней в 15 км с районом «avachinsky» — ветер и волнение (проба 968).
  // Зоны — из настоящего разбора, не переписанной копией.
  it('«юг края» Росгидромета доходит до Командор по координате, без района места', async () => {
    const [e] = meteoalertEvents(
      [{ regionId: '96', key: '21', level: 2, phenomenon: 'Ветер', text: 'местами 15-20 м/с', startUnix: Math.floor(Date.now() / 1000) - 60, minutes: 600 }],
      Date.now(),
    );
    const id = await insertAlert({ type: 'weather', title: `${e.title} (тест юга)`, zones: [...e.affected_zones] });
    const covered = await coveredBy(id);
    expect(covered).toContain(COMMANDER.id);
    expect(covered).toContain(CITY.id);
    // 29.10 (#2769, решение владельца «сузить»): «юг края» не доходит до
    // северной зоны — Шивелуча и Ключевской группы.
    expect(covered).not.toContain(SHIVELUCH.id);
  });

  it('одно явление в «севере» и «юге» края доходит и до севера, и до города', async () => {
    const start = Math.floor(Date.now() / 1000) - 60;
    const [e] = meteoalertEvents(
      [
        { regionId: '95', key: '21', level: 2, phenomenon: 'Ветер', text: 'местами 15-20 м/с', startUnix: start, minutes: 600 },
        { regionId: '96', key: '21', level: 2, phenomenon: 'Ветер', text: 'местами 15-20 м/с', startUnix: start, minutes: 600 },
      ],
      Date.now(),
    );
    const id = await insertAlert({ type: 'weather', title: `${e.title} (тест севера и юга)`, zones: [...e.affected_zones] });
    const covered = await coveredBy(id);
    expect(covered).toContain(SHIVELUCH.id);
    expect(covered).toContain(CITY.id);
  });

  // 16.10: угроза цунами КБГС несла четыре зоны буквами, и Командоры с
  // районом «commander» (Арка Стеллера с 1288) её не получали. Зоны — из
  // настоящего разбора.
  it('угроза цунами КБГС доходит до Командор, Корякского округа и города', async () => {
    const e = classifyMessage('t.me/kbgsras/test', 'Объявлена угроза цунами для восточного побережья Камчатки.', new Date().toISOString());
    expect(e?.alert_type).toBe('tsunami_warning');
    const id = await insertAlert({ type: 'tsunami_warning', title: `${e!.title} (тест)`, zones: [...e!.affected_zones] });
    const covered = await coveredBy(id);
    for (const p of [COMMANDER, FAR_NORTH, CITY, SHIVELUCH]) expect(covered, p.id).toContain(p.id);
  });

  // 16.10: угроза цунами МЧС без округа шла с пустыми зонами — пуш всем
  // подписчикам, а карточки «предупреждений по месту нет».
  it('угроза цунами МЧС без округа доходит до карточек всего края', async () => {
    const e = classifyMchsItem('mchs/test-tsunami', 'Угроза цунами', 'Объявлена угроза цунами на побережье.',
      new Date().toISOString(), 'https://example.test');
    expect(e?.alert_type).toBe('tsunami_warning');
    const id = await insertAlert({ type: 'tsunami_warning', title: `${e!.title} (тест МЧС)`, zones: [...e!.affected_zones] });
    const covered = await coveredBy(id);
    for (const p of [COMMANDER, FAR_NORTH, CITY, SHIVELUCH]) expect(covered, p.id).toContain(p.id);
  });

  // 16.10, карт-бланш владельца: Северные Курилы — Сахалинская область.
  // Камчатская погода и «юг края» по широте их не касаются, угроза цунами —
  // касается, тревога об Эбеко — их метка (lib/safety/kuril-north.ts).
  // Место заводится и убирается здесь же: соседние проверки сверяют охват
  // точным списком.
  it('Северные Курилы: «юг края» по широте — нет, цунами КБГС — да, Эбеко — их метка', async () => {
    const KURIL = { id: 'Северо-Курильск (тест)', ark: 'c0000000-0000-4000-8000-000000000021', lat: 50.678, lng: 156.125 };
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
       VALUES ($1, $1, $2, $3, $4, 'settlement', $5, TRUE)`,
      [KURIL.id, KURIL.lat, KURIL.lng, KURIL.ark, KURIL_NORTH_ZONE],
    );
    await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [KURIL.ark]);
    try {
      const south = await insertAlert({ type: 'flood', title: 'Паводок в южной половине края (тест Курил)', zones: mchs_zones('паводок в южной половине края') });
      const southCovered = await coveredBy(south);
      expect(southCovered).toContain(CITY.id);
      expect(southCovered).not.toContain(KURIL.id);

      const [e96] = meteoalertEvents(
        [{ regionId: '96', key: '31', level: 2, phenomenon: 'Ветер', text: 'местами 15-20 м/с', startUnix: Math.floor(Date.now() / 1000) - 60, minutes: 600 }],
        Date.now(),
      );
      const meteo = await insertAlert({ type: 'weather', title: `${e96.title} (тест Курил)`, zones: [...e96.affected_zones] });
      expect(await coveredBy(meteo)).not.toContain(KURIL.id);

      const t = classifyMessage('t.me/kbgsras/test-kuril', 'Объявлена угроза цунами для восточного побережья Камчатки.', new Date().toISOString());
      const tsunami = await insertAlert({ type: 'tsunami_warning', title: `${t!.title} (тест Курил)`, zones: [...t!.affected_zones] });
      expect(await coveredBy(tsunami)).toContain(KURIL.id);

      const ebeko = await insertAlert({ type: 'weather', title: 'Пепловый шлейф вулкана Эбеко (тест)', zones: mchs_zones('пепловые выбросы вулкана Эбеко') });
      const ebekoCovered = await coveredBy(ebeko);
      expect(ebekoCovered).toContain(KURIL.id);
      for (const p of [SHIVELUCH, KLYUCHEVSKOY, FAR_NORTH]) expect(ebekoCovered, p.id).not.toContain(p.id);
    } finally {
      await pool.query(`DELETE FROM location_real_time_status WHERE agent_route_id = $1`, [KURIL.ark]);
      await pool.query(`DELETE FROM places WHERE id = $1`, [KURIL.id]);
    }
  });

  // 16.10, карт-бланш владельца: район корякских мест — метка округа, а не
  // «северная». Место южнее широтной черты 57° доходит по метке; сводка об
  // Усть-Камчатском округе — нет.
  it('Корякский округ меткой района: южнее 57° — тоже; Усть-Камчатский — нет; север края — да', async () => {
    const KYTEPANA = { id: 'Большая Кытэпана (тест)', ark: 'c0000000-0000-4000-8000-000000000022', lat: 56.929, lng: 158.258 };
    await pool.query(
      `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
       VALUES ($1, $1, $2, $3, $4, 'volcano', $5, TRUE)`,
      [KYTEPANA.id, KYTEPANA.lat, KYTEPANA.lng, KYTEPANA.ark, KRAI_KORYAK_ZONE],
    );
    await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [KYTEPANA.ark]);
    try {
      const koryak = await insertAlert({ type: 'flood', title: 'Подъём воды на реках Тигильского района (тест)', zones: mchs_zones('подъём воды на реках Тигильского района') });
      expect(await coveredBy(koryak)).toContain(KYTEPANA.id);

      const uk = await insertAlert({ type: 'flood', title: 'Паводок в Усть-Камчатском районе (тест Корякского)', zones: mchs_zones('паводок в Усть-Камчатском районе') });
      expect(await coveredBy(uk)).not.toContain(KYTEPANA.id);

      const [e95] = meteoalertEvents(
        [{ regionId: '95', key: '41', level: 2, phenomenon: 'Метель', text: 'местами', startUnix: Math.floor(Date.now() / 1000) - 60, minutes: 600 }],
        Date.now(),
      );
      const north = await insertAlert({ type: 'weather', title: `${e95.title} (тест Корякского)`, zones: [...e95.affected_zones] });
      expect(await coveredBy(north)).toContain(KYTEPANA.id);
    } finally {
      await pool.query(`DELETE FROM location_real_time_status WHERE agent_route_id = $1`, [KYTEPANA.ark]);
      await pool.query(`DELETE FROM places WHERE id = $1`, [KYTEPANA.id]);
    }
  });

  it('«по всему краю» МЧС доходит до Командор и до Корякского округа', async () => {
    const id = await insertAlert({
      type: 'weather', title: 'Штормовое предупреждение по всему краю (тест)',
      zones: mchs_zones('Штормовое предупреждение по всему краю: ветер до 30 м/с'),
    });
    const covered = await coveredBy(id);
    for (const p of [COMMANDER, FAR_NORTH, CITY, SHIVELUCH]) expect(covered, p.id).toContain(p.id);
  });

  it('гидро-тревога 7–12.10 с разбором приёма: юг и Корякский округ, Ключевская группа — нет', async () => {
    const text =
      'На реках Елизовского муниципального округа ожидается подъём уровня воды интенсивностью до 20 сантиметров в сутки, '
      + 'на реках Усть-Большерецкого, Соболевского и Тигильского муниципальных округов — до 40 сантиметров в сутки, '
      + 'на реках Пенжинского и Олюторского муниципальных районов— до 50 сантиметров в сутки.';
    const id = await insertAlert({
      type: 'flood', title: 'Экстренное предупреждение на 7 - 12 октября (тест)', zones: mchs_zones(text),
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(CITY.id);
    expect(covered).toContain(FAR_NORTH.id);
    for (const p of [SHIVELUCH, KLYUCHEVSKOY, NEAR_SHIVELUCH, LINKED_FAR, COMMANDER]) {
      expect(covered, p.id).not.toContain(p.id);
    }
  });

  // ── Морская тревога не висит на горных местах (решение владельца 09.10, #2293) ──
  it('волнение моря по северной зоне: озеро — да, вулканы и горы — нет', async () => {
    const id = await insertAlert({
      type: 'weather', title: 'Экстренное предупреждение на 8-9 октября 2026 г. (опасное волнение моря)', zones: ['northern'],
    });
    expect(await coveredBy(id)).toEqual([FAR_NORTH.id]);
  });

  it('ветер вместе с волнением моря — не морская: вулкан её получает', async () => {
    const id = await insertAlert({
      type: 'weather', title: 'Экстренное предупреждение (сильный ветер, опасное волнение моря, тест)', zones: ['northern'],
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(SHIVELUCH.id);
    expect(covered.length).toBe(5);
  });

  it('«прибрежные события» Росгидромета на весь край: город у моря — да, вулкан — нет', async () => {
    const id = await insertAlert({
      type: 'weather', title: 'Росгидромет: прибрежные события — жёлтый уровень (юг края)',
      zones: ['avachinsky', 'eastern', 'western', 'northern'],
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(CITY.id);
    expect(covered).toContain(FAR_NORTH.id);
    expect(covered).not.toContain(SHIVELUCH.id);
    expect(covered).not.toContain(KLYUCHEVSKOY.id);
  });

  it('сервер узнаёт морскую тревогу так же, как isMarineAlert', async () => {
    const cases: Array<[string, string]> = [
      ['weather', 'Экстренное предупреждение на 8-9 октября 2026 г. (опасное волнение моря)'],
      ['weather', 'Росгидромет: прибрежные события — жёлтый уровень (юг края)'],
      ['weather', 'Экстренное предупреждение (сильный ветер, опасное волнение моря)'],
      ['weather', 'Экстренное предупреждение на 3 октября 2026 г. (сильный дождь)'],
      ['tsunami_warning', 'Угроза цунами: волнение моря у побережья'],
      ['weather', 'ОПАСНОЕ ВОЛНЕНИЕ МОРЯ'],
    ];
    for (const [type, title] of cases) {
      const { rows } = await pool.query<{ m: boolean }>(
        `SELECT ${MARINE_ALERT_SQL} AS m FROM (SELECT $1::text AS alert_type, $2::text AS title) ea`,
        [type, title],
      );
      expect(rows[0].m, title).toBe(isMarineAlert(type, title));
    }
  });

  it('закрытие парка накрывает место парка и место на его маршруте — не «рядом» и не город той же зоны (#2133)', async () => {
    const id = await insertAlert({
      type: 'park_closure',
      title: 'До 1 октября приостановлено посещение маршрутов в природных парках «Налычево» и «Южно-Камчатский»',
      zones: [],
      parks: ['nalychevo', 'yuzhno-kamchatsky'],
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(PARK_NAMED.id);
    expect(covered).toContain(ON_PARK_ROUTE.id);
    // «Рядом, загляните» в парке не лежит (§4.1).
    expect(covered).not.toContain(NEAR_PARK_ROUTE.id);
    // Та же зона avachinsky, но не парк: зона здесь не решает.
    expect(covered).not.toContain(CITY.id);
    // Ни один северный объект.
    expect(covered).not.toContain(SHIVELUCH.id);
  });

  it('закрытие Южно-Камчатского доходит до Мутновского через маршрут с записанной территорией (разбор 03.11)', async () => {
    const MUT = { id: 'Вулкан Мутновский (тест)', ark: 'c0000000-0000-4000-8000-000000000031' };
    const GOR = { id: 'Вулкан Горелый (тест)', ark: 'c0000000-0000-4000-8000-000000000032' };
    for (const p of [MUT, GOR]) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $1, 52.45, 158.19, $2, 'volcano', 'southern', TRUE)`,
        [p.id, p.ark],
      );
      await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [p.ark]);
    }
    // Путевых точек нет — только территория и имя места в названии.
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, park_name, zone, is_visible)
       VALUES ('d0000000-0000-4000-8000-000000000011', 'trekking', 'К подножию вулкана Мутновский (тест)', 'Южно-Камчатский', 'southern', TRUE)`,
    );
    const id = await insertAlert({
      type: 'park_closure',
      title: 'Приостановлено посещение маршрутов в природном парке «Южно-Камчатский»',
      zones: [],
      parks: ['yuzhno-kamchatsky'],
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(MUT.id);
    // Маршрута с его именем нет — парк его не красит.
    expect(covered).not.toContain(GOR.id);
    expect(covered).not.toContain(CITY.id);
    // Закрытие Налычево Мутновский не трогает.
    const other = await insertAlert({ type: 'park_closure', title: 'Налычево закрыт', zones: [], parks: ['nalychevo'] });
    expect(await coveredBy(other)).not.toContain(MUT.id);
  });

  it('закрытие Южно-Камчатского доходит до пещер Горелого: имя маршрута парка целиком в имени места (#2980)', async () => {
    const CAVES = { id: 'Лавовые пещеры вулкана Горелый (тест)', ark: 'c0000000-0000-4000-8000-000000000041' };
    const KURIL = { id: 'Курильская бухта острова Шумшу (тест)', ark: 'c0000000-0000-4000-8000-000000000042' };
    for (const p of [CAVES, KURIL]) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $1, 52.55, 158.03, $2, 'cave', 'southern', TRUE)`,
        [p.id, p.ark],
      );
      await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [p.ark]);
    }
    // Путевых точек нет; у места лишнее слово «лавовые», которого нет в маршруте.
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, park_name, zone, is_visible)
       VALUES ('d0000000-0000-4000-8000-000000000041', 'trekking', 'Пещеры вулкана Горелый', 'Южно-Камчатский', 'southern', TRUE),
              ('d0000000-0000-4000-8000-000000000042', 'trekking', 'Курильское озеро', 'Южно-Камчатский', 'southern', TRUE)`,
    );
    const id = await insertAlert({
      type: 'park_closure',
      title: 'Закрыты туристские маршруты природного парка «Южно-Камчатский»',
      zones: [],
      parks: ['yuzhno-kamchatsky'],
    });
    const covered = await coveredBy(id);
    expect(covered).toContain(CAVES.id);
    // Одно значимое слово маршрута («курильское») место с ним не связывает.
    expect(covered).not.toContain(KURIL.id);
    expect(covered).not.toContain(CITY.id);
    // Закрытие Налычево пещеры не трогает.
    const other = await insertAlert({ type: 'park_closure', title: 'Налычево закрыт', zones: [], parks: ['nalychevo'] });
    expect(await coveredBy(other)).not.toContain(CAVES.id);
  });

  it('1393: записанная тревога 02.11 «на всех территориях природных парков» получает парки и красит Налычево (#2980)', async () => {
    const TITLE = 'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья';
    // Как её записал прежний классификатор: без парков и без зон.
    const live = await insertAlert({ type: 'info', title: TITLE, zones: [], parks: null });
    const reopened = await insertAlert({
      type: 'info', title: 'Маршруты «Вулканы Камчатки»: возобновлено посещение на всех территориях природных парков', zones: [], parks: null,
    });
    const expired = (await pool.query<{ id: string }>(
      `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, created_at, expires_at, source_url, external_id)
       VALUES ('info', 2, $1, $2, '{}', NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day', 'https://example.test', 'expired-1393')
       RETURNING id::text AS id`,
      [TITLE, TITLE],
    )).rows[0]!.id;
    expect(await coveredBy(live)).not.toContain(PARK_NAMED.id);

    const sql = readFileSync(join(process.cwd(), 'migrations', '1393_park_closure_all_natural_parks_backfill.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql); // повтор — без изменений

    expect(await coveredBy(live)).toContain(PARK_NAMED.id);
    expect(await coveredBy(live)).not.toContain(CITY.id);
    const parksOf = async (id: string) =>
      (await pool.query<{ alert_type: string; affected_parks: string[] | null }>(
        `SELECT alert_type, affected_parks FROM external_alerts WHERE id::text = $1`, [id],
      )).rows[0];
    expect(await parksOf(live)).toEqual({
      alert_type: 'park_closure',
      affected_parks: ['nalychevo', 'yuzhno-kamchatsky', 'bystrinskiy', 'klyuchevskoy', 'vilyuchinsky'],
    });
    // Открытие и вышедшая из ленты тревога не тронуты.
    expect(await parksOf(reopened)).toEqual({ alert_type: 'info', affected_parks: null });
    expect(await parksOf(expired)).toEqual({ alert_type: 'info', affected_parks: null });
  });

  it('сезонное закрытие, записанное до правила 06.11, держится 21 сутки от публикации (проход приёма)', async () => {
    const TITLE = 'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья';
    const PARKS = ['nalychevo', 'yuzhno-kamchatsky', 'bystrinskiy', 'klyuchevskoy', 'vilyuchinsky'];
    // created_at и expires_at — стенным UTC, как пишет приём (#2495).
    const row = async (opts: { externalId: string; title: string; description?: string; sourceUrl?: string; ageDays: number; leftHours: number }) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                      created_at, expires_at, source_url, external_id)
         VALUES ('park_closure', 2, $1, $6, '{}', $2,
                 (NOW() AT TIME ZONE 'UTC') - make_interval(days => $3::int),
                 (NOW() AT TIME ZONE 'UTC') + make_interval(hours => $4::int),
                 $7, $5)
         RETURNING id::text AS id`,
        [opts.title, PARKS, opts.ageDays, opts.leftHours, opts.externalId, opts.description ?? '', opts.sourceUrl ?? 'https://example.test'],
      )).rows[0]!.id;

    // Сводка 02.11 из ленты: 4 дня назад, по прежнему сроку осталось 3 дня.
    const seasonal = await row({ externalId: 'visitkamchatka/2026-11-02/thold1', title: TITLE, ageDays: 4, leftHours: 72 });
    // То же закрытие, внесённое руками: срок ставит человек — не трогаем.
    const manual = await row({ externalId: 'manual-zakrytie-parkov', title: TITLE, ageDays: 4, leftHours: 72 });
    // Ручная со ссылкой на пост в MAX: alertOrigin узнал бы её лентой MAX по адресу.
    const manualMax = await row({ externalId: 'manual-zakrytie-parkov-max', title: TITLE, sourceUrl: 'https://max.ru/mchs41/AZ123', ageDays: 4, leftHours: 72 });
    // id, заданный администратором в форме канала: не форма классификатора.
    const foreign = await row({ externalId: 't.me/minturkam/555', title: TITLE, ageDays: 4, leftHours: 72 });
    // Описание обрезано до 800: дата открытия могла остаться за краем.
    const clipped = await row({ externalId: 'vk_mchs/2026-11-04/tclip1', title: TITLE, description: 'а'.repeat(800), ageDays: 2, leftHours: 72 });
    // Оперативное закрытие без даты (циклон) — правило не меняется.
    const cyclone = await row({ externalId: 'max_mchs/2026-11-05/thold2', title: 'Приостановлено посещение маршрутов в природном парке «Налычево» из-за циклона', ageDays: 1, leftHours: 24 });
    // Уже истёкшее сезонное — не воскрешаем: так же выглядит снятое админом.
    const gone = await row({ externalId: 'visitkamchatka/2026-10-10/thold3', title: TITLE, ageDays: 20, leftHours: -1 });
    // Снятое админом МЕЖДУ чтением и записью прохода — тоже не воскресает.
    const raced = await row({ externalId: 'visitkamchatka/2026-11-03/thold4', title: TITLE, ageDays: 3, leftHours: 96 });

    const termDays = async (id: string) =>
      Number((await pool.query<{ d: string }>(
        `SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 86400 AS d FROM external_alerts WHERE id::text = $1`, [id],
      )).rows[0]!.d);
    const untouched = [manual, manualMax, foreign, clipped, cyclone, gone];
    const before = new Map<string, number>();
    for (const id of untouched) before.set(id, await termDays(id));

    let reads = 0;
    const query = async <T,>(sql: string, params: unknown[]) => {
      const r = await pool.query(sql, params);
      // Сразу после чтения — админский DELETE /api/admin/external-alerts/[id].
      if (reads++ === 0) await pool.query(`UPDATE external_alerts SET expires_at = (NOW() AT TIME ZONE 'UTC') WHERE id::text = $1`, [raced]);
      return r as unknown as { rows: T[] };
    };
    const events: Array<{ entityId: string | null; details?: Record<string, unknown> }> = [];
    const record = async (e: { entityId: string | null; details?: Record<string, unknown> }) => { events.push(e); };

    const first = await holdParkClosures(query, record);
    expect(first.extended).toBe(1);
    expect(first.extended_ids).toEqual([seasonal]);
    // Счёт пропусков видит и строки соседних тестов этого файла — судим не
    // его, а сроки своих строк ниже; здесь — что каждая причина сработала.
    expect(first.skipped.manual).toBeGreaterThanOrEqual(2);
    expect(first.skipped.foreign_id).toBeGreaterThanOrEqual(1);
    expect(first.skipped.clipped).toBeGreaterThanOrEqual(1);
    expect(await termDays(seasonal)).toBeCloseTo(PARK_CLOSURE_HOLD_HOURS / 24, 3);
    for (const id of untouched) expect(await termDays(id), id).toBeCloseTo(before.get(id)!, 6);
    const racedLive = (await pool.query<{ live: boolean }>(
      `SELECT expires_at > (NOW() AT TIME ZONE 'UTC') AS live FROM external_alerts WHERE id::text = $1`, [raced],
    )).rows[0]!.live;
    expect(racedLive).toBe(false);
    // Продление названо в журнале решений: прежний и новый срок.
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(seasonal);
    expect(events[0].details).toHaveProperty('prior_expires_at');
    // Повтор ничего не меняет: продлевать уже нечего.
    expect((await holdParkClosures((sql, params) => pool.query(sql, params), record)).extended).toBe(0);

    // И главное: после прежнего срока тревога всё ещё красит место парка.
    expect(await coveredBy(seasonal)).toContain(PARK_NAMED.id);
    await pool.query(`DELETE FROM external_alerts WHERE id::text = ANY($1::text[])`, [[seasonal, raced, ...untouched]]);
  });

  it('звонок о закрытии парка глушится только закрытием тех же парков (push, 06.11)', async () => {
    const pushed = (await pool.query<{ id: string }>(
      `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                    created_at, expires_at, source_url, external_id, push_sent_at)
       VALUES ('park_closure', 2, 'Парк «Ключевской»: маршруты закрыты на зимний сезон', '', '{}', ARRAY['klyuchevskoy'],
               (NOW() AT TIME ZONE 'UTC') - INTERVAL '6 days', (NOW() AT TIME ZONE 'UTC') + INTERVAL '15 days',
               'https://example.test', 'visitkamchatka/2026-10-31/tpush1', NOW())
       RETURNING id::text AS id`,
    )).rows[0]!.id;
    const same = async (parks: string[] | null) =>
      (await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM external_alerts
          WHERE alert_type = 'park_closure' AND push_sent_at IS NOT NULL
            AND expires_at > (NOW() AT TIME ZONE 'UTC') AND ${sameParksSql('$1')}`,
        [parks],
      )).rows.map((r) => r.id);
    // Закрыли Налычево — звонок должен уйти, хотя о Ключевском уже звонили.
    expect(await same(sameParksParam({ alert_type: 'park_closure', affected_parks: ['nalychevo'] }))).not.toContain(pushed);
    // Повтор о Ключевском — тот же звонок, глушится.
    expect(await same(sameParksParam({ alert_type: 'park_closure', affected_parks: ['klyuchevskoy'] }))).toContain(pushed);
    // Прочие роды правила парков не знают — как раньше.
    expect(await same(sameParksParam({ alert_type: 'flood', affected_parks: null }))).toContain(pushed);
    await pool.query(`DELETE FROM external_alerts WHERE id::text = $1`, [pushed]);
  });

  it('закрытие без названного парка не красит никого — «не установлено» ≠ «везде»', async () => {
    const id = await insertAlert({ type: 'park_closure', title: 'Маршруты закрыты', zones: ['avachinsky'], parks: null });
    expect(await coveredBy(id)).toEqual([]);
  });

  it('Южно-Камчатский заведён миграцией 1124 с корнем для тревог; страницей стал в 1250', async () => {
    // 1124 завела запись выключенной — только ради тревог о закрытии, а тревоги
    // `is_active` не смотрят. 1250 (14.10) включила страницу кластера
    // национального парка «Вулканы Камчатки»; корень поиска остался прежним.
    const { rows } = await pool.query<{ is_active: boolean; search_term: string }>(
      `SELECT is_active, search_term FROM parks WHERE slug = 'yuzhno-kamchatsky'`,
    );
    expect(rows).toEqual([{ is_active: true, search_term: 'Южно-Камчат' }]);
  });

  it('карточка маршрута парка видит закрытие тем же правилом (collect-signals, #2133)', async () => {
    const title = 'Закрыты маршруты природного парка «Налычево» (тест маршрута)';
    await insertAlert({ type: 'park_closure', title, zones: [], parks: ['nalychevo'] });
    const q: QueryFn = (sql, params) => pool.query(sql, params) as never;
    const signals = await collectRouteSignals(PARK_ROUTE_ID, { query: q, month: 10 });
    expect(signals.alerts, 'запрос предупреждений маршрута не выполнился').not.toBeNull();
    expect(signals.alerts!.map((a) => a.title)).toContain(title);
    expect(signals.alerts!.find((a) => a.title === title)?.type).toBe('park_closure');
  });

  /**
   * Маршрут «Гора Замок» (скрин владельца 03.10). Карточка места уже судила
   * тревоги правилом мест, а карточка маршрута — своим: дорожное в 40 км и
   * непривязанное дорожное висели в «Осторожно · на сегодня».
   */
  describe('маршрут судится правилом мест (03.10, «Гора Замок»)', () => {
    const ROUTE = '66061e18-77ba-433f-b812-81e138266b2e';
    const PLACE = 'da81b46f-29dc-42e8-8137-ed2107347a68';
    const q: QueryFn = (sql, params) => pool.query(sql, params) as never;
    const titles = async (routeId: string) => {
      const s = await collectRouteSignals(routeId, { query: q, month: 10 });
      expect(s.alerts, 'запрос предупреждений маршрута не выполнился').not.toBeNull();
      return s.alerts!;
    };

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, lat, lng, is_visible)
         VALUES ($1, 'trekking', 'Гора Замок', 'avachinsky', 53.182662, 158.233294, TRUE)`,
        [ROUTE],
      );
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, 'Гора Замок', 53.1778026, 158.1944257, gen_random_uuid(), 'mountain', 'avachinsky', TRUE)`,
        [PLACE],
      );
      await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1, $2, 1, 'nearby')`,
        [ROUTE, PLACE],
      );
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible)
         VALUES ('d0000000-0000-4000-8000-0000000000aa', 'trekking', 'Маршрут без координат (тест)', 'avachinsky', TRUE)`,
      );
    });

    it('дорожное за 40 км (Халактырский пляж) — не про этот маршрут: дорога судится в 30 км', async () => {
      const t = 'Халактырский пляж: дорога перекрыта (тест маршрута)';
      await insertAlert({ type: 'road_closure', title: t, zones: ['avachinsky'], lat: 53.08, lng: 158.83 });
      expect((await titles(ROUTE)).map((a) => a.title)).not.toContain(t);
    });

    it('дорожное без привязки — не красит никого, и маршрут тоже (27.09)', async () => {
      const t = 'Перевал: проезд по пропускам (тест маршрута)';
      await insertAlert({ type: 'road_closure', title: t, zones: ['avachinsky'] });
      expect((await titles(ROUTE)).map((a) => a.title)).not.toContain(t);
    });

    it('дорожное у самого маршрута доходит, и не как зональное', async () => {
      const t = 'Дорога к подножию Замка размыта (тест маршрута)';
      await insertAlert({ type: 'road_closure', title: t, zones: ['avachinsky'], lat: 53.19, lng: 158.30 });
      const a = (await titles(ROUTE)).find((x) => x.title === t);
      expect(a).toBeDefined();
      expect(a!.zonal).toBe(false);
    });

    it('зональное (паводок без координаты) доходит и помечено зональным', async () => {
      const t = 'Паводок в Авачинской зоне (тест маршрута)';
      await insertAlert({ type: 'flood', title: t, zones: ['avachinsky'] });
      const a = (await titles(ROUTE)).find((x) => x.title === t);
      expect(a?.zonal).toBe(true);
      // Маршрут без единой координаты зональное тоже получает: мерить нечем,
      // но зона известна.
      expect((await titles('d0000000-0000-4000-8000-0000000000aa')).map((x) => x.title)).toContain(t);
    });

    it('морская тревога маршрут не обходит: у маршрута нет типа места (#2293)', async () => {
      const t = 'Экстренное предупреждение (опасное волнение моря, тест маршрута)';
      await insertAlert({ type: 'weather', title: t, zones: ['avachinsky'] });
      expect((await titles(ROUTE)).map((a) => a.title)).toContain(t);
    });

    it('миграция 1153 делает «Гору Замок» точкой пути своего маршрута', async () => {
      const sql = readFileSync(join(process.cwd(), 'migrations', '1153_zamok_route_waypoint.sql'), 'utf8');
      await pool.query(sql);
      const { rows } = await pool.query<{ link_kind: string }>(
        `SELECT link_kind FROM route_waypoints WHERE route_id = $1 AND place_id = $2`, [ROUTE, PLACE],
      );
      expect(rows).toEqual([{ link_kind: 'waypoint' }]);
    });
  });

  /**
   * Предупреждение без срока — снимок дня публикации (03.10). Сводка АТК от
   * 23.08 «до ручного снятия» стояла в октябре на каждом маршруте края.
   */
  it('safety_alerts: без срока — показывается UNDATED_ALERT_HORIZON_DAYS суток, не дольше', async () => {
    await pool.query(
      `INSERT INTO safety_alerts (zone, severity, title, message, source, active_from, active_until)
       VALUES ('all', 'important', 'Старая сводка без срока (тест)', 'Проезд перекрыт, тест', 'тест', NOW() - INTERVAL '41 days', NULL),
              ('all', 'important', 'Свежая сводка без срока (тест)', 'Проезд перекрыт, тест', 'тест', NOW() - INTERVAL '1 day', NULL),
              ('all', 'important', 'Старая сводка со сроком (тест)', 'Проезд перекрыт, тест', 'тест', NOW() - INTERVAL '41 days', NOW() + INTERVAL '5 days')`,
    );
    const { rows } = await pool.query<{ title: string }>(ACTIVE_ZONE_ALERTS_SQL, ['avachinsky', UNDATED_ALERT_HORIZON_DAYS]);
    const got = rows.map((r) => r.title);
    expect(got).toContain('Свежая сводка без срока (тест)');
    expect(got).toContain('Старая сводка со сроком (тест)');
    expect(got).not.toContain('Старая сводка без срока (тест)');
  });

  /**
   * Перепись охвата (15.10, #83) — тем же предикатом и теми же пробами, что
   * роут /api/cron/place-zone-census. Место с районом вне четвёрки и место без
   * строки реалтайма заводятся здесь, последним случаем файла, и убираются:
   * чужие счёты охвата выше от них не меняются.
   */
  it('перепись охвата: Командоры — по координате, район вне четвёрки и место без реалтайма — названы', async () => {
    const MUTNOVSKY = { id: 'Мутновское плато (тест)', ark: 'c0000000-0000-4000-8000-000000000011', lat: 52.450, lng: 158.200 };
    const NO_STATUS = { id: 'Место без реалтайма (тест)', ark: 'c0000000-0000-4000-8000-000000000012', lat: 53.050, lng: 158.600 };
    for (const [p, zone] of [[MUTNOVSKY, 'mutnovsky'], [NO_STATUS, 'avachinsky']] as const) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
         VALUES ($1, $1, $2, $3, $4, 'plateau', $5, TRUE)`,
        [p.id, p.lat, p.lng, p.ark, zone],
      );
    }
    await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [MUTNOVSKY.ark]);
    // Маршрут без своей зоны, но с точкой пути у города: collect-signals берёт
    // зону у места на пути — значит и перепись обязана.
    const BARE_ROUTE = 'd0000000-0000-4000-8000-0000000000bb';
    await pool.query(
      `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible)
       VALUES ($1, 'trekking', 'Маршрут без зоны (тест)', NULL, TRUE)`,
      [BARE_ROUTE],
    );
    await pool.query(
      `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1, $2, 0, 'waypoint')`,
      [BARE_ROUTE, CITY.id],
    );
    try {
      const probes = zoneProbes();
      const { rows } = await pool.query<ZoneCensusRow>(ZONE_CENSUS_SQL, [JSON.stringify(probes)]);
      const by = new Map(rows.filter((r) => r.target === 'place').map((r) => [r.id, r]));
      // Маршрут судится тем же правилом, что место (collect-signals): зона «avachinsky».
      expect(rows.find((r) => r.target === 'route' && r.id === PARK_ROUTE_ID)?.reached_by).toEqual(['krai_wide', 'meteo_south']);
      // Своей зоны нет — зона у места на пути, как в collect-signals.
      const bare = rows.find((r) => r.target === 'route' && r.id === BARE_ROUTE);
      expect(bare?.zone).toBe('avachinsky');
      expect(bare?.reached_by).toEqual(['krai_wide', 'meteo_south']);
      expect(by.get(COMMANDER.id)?.reached_by).toEqual(['krai_wide', 'meteo_south']);
      // «Юг края» без северной зоны (29.10, #2769): северное место — только «север».
      expect(by.get(FAR_NORTH.id)?.reached_by).toEqual(['krai_wide', 'meteo_north']);
      expect(by.get(CITY.id)?.reached_by).toEqual(['krai_wide', 'meteo_south']);
      expect(by.get(MUTNOVSKY.id)?.reached_by).toEqual([]);

      // Принадлежность, а не точные списки: в базе есть и места других
      // случаев файла («Гора Замок» — без строки реалтайма).
      const { places } = summarizeZoneCensus(rows, probes);
      const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);
      expect(ids(places.unreached.krai_wide)).toContain(MUTNOVSKY.id);
      for (const p of [COMMANDER, CITY, FAR_NORTH, SHIVELUCH]) expect(ids(places.unreached.krai_wide), p.id).not.toContain(p.id);
      expect(ids(places.unreached.krai_wide), 'место без реалтайма — в своём списке').not.toContain(NO_STATUS.id);
      expect(ids(places.no_status)).toContain(NO_STATUS.id);
      expect(ids(places.no_status)).not.toContain(MUTNOVSKY.id);
      expect(ids(places.commander_box)).toContain(COMMANDER.id);
      expect(ids(places.commander_box)).not.toContain(CITY.id);
      expect(ids(places.koryak)).toContain(FAR_NORTH.id);
      expect(ids(places.koryak)).not.toContain(SHIVELUCH.id);
      expect(places.by_zone.find((z) => z.zone === 'mutnovsky')).toMatchObject({ alert_zone: false, count: 1 });
      expect(places.by_zone.find((z) => z.zone === 'northern')).toMatchObject({ alert_zone: true });
    } finally {
      await pool.query(`DELETE FROM route_waypoints WHERE route_id = $1`, [BARE_ROUTE]);
      await pool.query(`DELETE FROM kamchatka_routes WHERE id = $1`, [BARE_ROUTE]);
      await pool.query(`DELETE FROM location_real_time_status WHERE agent_route_id = ANY($1::uuid[])`, [[MUTNOVSKY.ark, NO_STATUS.ark]]);
      await pool.query(`DELETE FROM places WHERE id = ANY($1::text[])`, [[MUTNOVSKY.id, NO_STATUS.id]]);
    }
  }, 20_000); // прогоняет ALERT_MATCH_SQL по всем местам: 3–3,5 с на локальном PostgreSQL, на CI ближе к 5 (#2980)

  // ── Сводка об открытии и «статус парка не известен» (решение владельца 06.11) ──
  //
  // Закрытие на межсезонье держится до сводки об открытии; истекло без неё —
  // «не знаю», жёлтое, а не зелёное. Проходы приёма (park-reopening.ts) и
  // НАСТОЯЩИЙ запрос пересчёта статуса крона — здесь, на сервере: правило
  // жёлтого живёт в CASE, а вывод «не знаю» — в сверке строк по времени.
  // Парки — свои, тестовые: живые закрытия Налычево из случаев выше файла
  // не должны решать за эти проверки.
  describe('открытие снимает закрытие, «не знаю» после предела (06.11)', () => {
    const HOURS = (d: number) => d * 24;
    const feedId = (tag: string) => `visitkamchatka/2026-11-02/ta2${tag}`;
    const made: string[] = [];
    const alertRow = async (o: {
      type: 'park_closure' | 'park_reopening' | 'road_closure'; externalId: string; parks: string[] | null; title: string;
      ageHours: number; leftHours?: number; endedBy?: string | null; severity?: number; lat?: number; lng?: number;
    }) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                      created_at, last_published_at, expires_at, source_url, external_id, ended_by, lat, lng)
         VALUES ($1, $2, $3, '', '{}', $4,
                 (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $5::int),
                 (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $5::int),
                 (NOW() AT TIME ZONE 'UTC') + make_interval(hours => $6::int),
                 'https://t.me/s/visitkamchatka41/1', $7, $8, $9, $10)
         RETURNING id::text AS id`,
        [o.type, o.severity ?? (o.type === 'park_reopening' ? 0 : 2), o.title, o.parks, o.ageHours,
          o.leftHours ?? (o.type === 'park_reopening' ? -o.ageHours : HOURS(21)), o.externalId, o.endedBy ?? null, o.lat ?? null, o.lng ?? null],
      );
      made.push(r.rows[0]!.id);
      return r.rows[0]!.id;
    };
    const state = async (id: string) => (await pool.query<{ parks: string[] | null; live: boolean; ended_by: string | null }>(
      `SELECT affected_parks AS parks, expires_at > (NOW() AT TIME ZONE 'UTC') AS live, ended_by FROM external_alerts WHERE id::text = $1`, [id],
    )).rows[0];
    const q = async <T,>(sql: string, params: unknown[]) => (await pool.query(sql, params)) as unknown as { rows: T[] };

    /**
     * Пересчёт статуса мест — ТЕМ ЖЕ текстом, что в кроне (updateRealTimeStatus
     * в safety-ingest): CASE не экспортирован, и копия в тесте судила бы копию.
     * Подставляются только известные константы; новая — громкий отказ.
     */
    async function recomputeStatus(): Promise<void> {
      const src = readFileSync(join(process.cwd(), 'app/api/cron/safety-ingest/route.ts'), 'utf8');
      const fn = src.slice(src.indexOf('async function updateRealTimeStatus'), src.indexOf('async function dispatchPushAlerts'));
      const open = 'return client.query(`';
      const start = fn.indexOf(open);
      const end = fn.indexOf('`, [VOLCANO_STALE_DAYS', start);
      expect(start, 'запрос пересчёта найден в кроне').toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const subs: Record<string, string> = {
        ALERT_MATCH_SQL, ALERT_ZONAL_ONLY_SQL, TOURIST_BAN_SQL, PARK_STATUS_UNKNOWN_SQL, UTC_WALL_NOW_SQL,
      };
      const sql = fn.slice(start + open.length, end).replace(/\$\{(\w+)\}/g, (_m, name: string) => {
        if (!(name in subs)) throw new Error(`в запросе пересчёта новая подстановка \${${name}} — добавь её в тест`);
        return subs[name];
      });
      await pool.query(sql, [VOLCANO_STALE_DAYS, KFEGS_MAX_AGE_DAYS + 1]);
    }
    const statusOf = async (ark: string) => (await pool.query<{ status: string; alerts: string[]; sev: number }>(
      `SELECT recommender_status AS status, active_alerts AS alerts, alert_severity::int AS sev
         FROM location_real_time_status WHERE agent_route_id = $1`, [ark],
    )).rows[0];

    const UNKNOWN_PARKS = [
      { slug: 'a2-u-season', name: 'Природный парк «Сезонный»', term: 'Сезонный' },
      { slug: 'a2-u-admin', name: 'Природный парк «Снятый»', term: 'Снятый' },
      { slug: 'a2-u-legacy', name: 'Природный парк «Давний»', term: 'Давний' },
      { slug: 'a2-u-cyclone', name: 'Природный парк «Циклонный»', term: 'Циклонный' },
      { slug: 'a2-u-opened', name: 'Природный парк «Открытый»', term: 'Открытый' },
      { slug: 'a2-u-live', name: 'Природный парк «Живой»', term: 'Живой' },
      { slug: 'a2-u-old', name: 'Природный парк «Старый»', term: 'Старый' },
      { slug: 'a2-u-manual', name: 'Природный парк «Ручной»', term: 'Ручной' },
      { slug: 'a2-u-twice', name: 'Природный парк «Двойной»', term: 'Двойной' },
      { slug: 'a2-u-rejected', name: 'Природный парк «Отклонённый»', term: 'Отклонённый' },
    ];
    const SEASON_PLACE = { id: 'Природный парк Сезонный (тест)', ark: 'c0000000-0000-4000-8000-0000000000a1', lat: 53.30, lng: 158.80 };
    const ROAD_PLACE = { id: 'Дорожная развилка (тест)', ark: 'c0000000-0000-4000-8000-0000000000a2', lat: 53.70, lng: 158.40 };

    beforeAll(async () => {
      // Мир этих проверок — только свои тревоги. Случаи выше оставили живыми
      // цунами, запреты и зональные погоды «по всему краю» — они накрыли бы и
      // эти места, и цвет судил бы чужое. Блок последний в файле: гасить их
      // можно, дальше их никто не читает.
      await pool.query(`UPDATE external_alerts SET expires_at = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 second'
                         WHERE expires_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 second'`);
      for (const p of UNKNOWN_PARKS) {
        await pool.query(
          `INSERT INTO parks (slug, display_name, search_term) VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
          [p.slug, p.name, p.term],
        );
      }
      for (const p of [SEASON_PLACE, ROAD_PLACE]) {
        await pool.query(
          `INSERT INTO places (id, name, lat, lng, ark_id, location_type, zone, is_visible)
           VALUES ($1, $1, $2, $3, $4, 'lake', 'avachinsky', TRUE)`,
          [p.id, p.lat, p.lng, p.ark],
        );
        await pool.query(`INSERT INTO location_real_time_status (agent_route_id) VALUES ($1)`, [p.ark]);
      }
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM external_alerts WHERE id::text = ANY($1::text[]) OR external_id LIKE 'park-unknown/a2-%'`, [made]);
      await pool.query(`DELETE FROM location_real_time_status WHERE agent_route_id = ANY($1::uuid[])`, [[SEASON_PLACE.ark, ROAD_PLACE.ark]]);
      await pool.query(`DELETE FROM places WHERE id = ANY($1::text[])`, [[SEASON_PLACE.id, ROAD_PLACE.id]]);
      await pool.query(`DELETE FROM parks WHERE slug = ANY($1::text[])`, [UNKNOWN_PARKS.map((p) => p.slug)]);
    });

    it('открытие снимает свои парки с более раннего закрытия: частично — сужает, целиком — гасит; позднее, ручное и снятое не трогает', async () => {
      const A = 'a2-park-a';
      const B = 'a2-park-b';
      const TITLE = 'Маршруты природных парков закрыты на период межсезонья';
      await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-05/oa2open1', parks: [A], title: 'Маршруты парка открыты', ageHours: 24 });
      const partial = await alertRow({ type: 'park_closure', externalId: feedId('p1'), parks: [A, B], title: TITLE, ageHours: 72 });
      const full = await alertRow({ type: 'park_closure', externalId: feedId('p2'), parks: [A], title: TITLE, ageHours: 72 });
      // Опубликовано ПОСЛЕ открытия: новая сводка о закрытии сильнее старой об открытии.
      const after = await alertRow({ type: 'park_closure', externalId: feedId('p3'), parks: [A], title: TITLE, ageHours: 12 });
      const manual = await alertRow({ type: 'park_closure', externalId: 'manual-a2-park-a', parks: [A], title: TITLE, ageHours: 72 });
      const other = await alertRow({ type: 'park_closure', externalId: feedId('p5'), parks: [B], title: TITLE, ageHours: 72 });
      // Снятое админом МЕЖДУ чтением и записью прохода — не «снято открытием».
      const raced = await alertRow({ type: 'park_closure', externalId: feedId('p4'), parks: [A], title: TITLE, ageHours: 72 });

      let reads = 0;
      const racing = async <T,>(sql: string, params: unknown[]) => {
        const r = await pool.query(sql, params);
        if (++reads === 2) {
          await pool.query(`UPDATE external_alerts SET expires_at = (NOW() AT TIME ZONE 'UTC'), ended_by = 'admin' WHERE id::text = $1`, [raced]);
        }
        return r as unknown as { rows: T[] };
      };
      const events: Array<{ entityId: string | null; details?: Record<string, unknown> }> = [];
      const record = async (e: { entityId: string | null; details?: Record<string, unknown> }) => { events.push(e); };

      const res = await applyParkReopenings(racing, record);
      expect(res.narrowed).toBe(1);
      expect(res.ended).toBe(1);
      expect([...res.changed_ids].sort()).toEqual([partial, full].sort());
      expect(await state(partial)).toEqual({ parks: [B], live: true, ended_by: null });
      // Погашенное целиком хранит, что было закрыто, и кто погасил.
      expect(await state(full)).toEqual({ parks: [A], live: false, ended_by: 'reopening' });
      for (const id of [after, manual]) expect(await state(id)).toEqual({ parks: [A], live: true, ended_by: null });
      expect(await state(other)).toEqual({ parks: [B], live: true, ended_by: null });
      expect(await state(raced)).toEqual({ parks: [A], live: false, ended_by: 'admin' });
      // Каждое изменение — в журнале решений: прежние и новые парки.
      expect(events.map((e) => e.entityId).sort()).toEqual([partial, full].sort());
      expect(events.find((e) => e.entityId === partial)?.details).toMatchObject({ prior_parks: [A, B], parks: [B], opened_parks: [A] });
      // Повтор прохода ничего не меняет.
      const again = await applyParkReopenings(q, record);
      expect(again.narrowed + again.ended).toBe(0);
      expect(events).toHaveLength(2);
    });

    it('сезонное закрытие истекло без открытия — «статус не известен»: место ЖЁЛТОЕ настоящим CASE крона, уровень 1 дороги — по-прежнему зелёный', async () => {
      const seasonal = (term: string) => `Маршруты природного парка «${term}» закрыты на период межсезонья`;
      // Истекло само 4 дня назад, сводка — 25 дней назад.
      const basis = await alertRow({ type: 'park_closure', externalId: feedId('u1'), parks: ['a2-u-season'], title: seasonal('Сезонный'), ageHours: HOURS(25), leftHours: -HOURS(4) });
      await alertRow({ type: 'park_closure', externalId: feedId('u2'), parks: ['a2-u-admin'], title: seasonal('Снятый'), ageHours: HOURS(25), leftHours: -HOURS(4), endedBy: 'admin' });
      await alertRow({ type: 'park_closure', externalId: feedId('u3'), parks: ['a2-u-legacy'], title: seasonal('Давний'), ageHours: HOURS(25), leftHours: -HOURS(4), endedBy: 'legacy' });
      await alertRow({ type: 'park_closure', externalId: feedId('u4'), parks: ['a2-u-cyclone'], title: 'Приостановлено посещение маршрутов в природном парке «Циклонный» из-за циклона', ageHours: HOURS(5), leftHours: -HOURS(3) });
      await alertRow({ type: 'park_closure', externalId: feedId('u5'), parks: ['a2-u-opened'], title: seasonal('Открытый'), ageHours: HOURS(25), leftHours: -HOURS(4) });
      await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-01/oa2open2', parks: ['a2-u-opened'], title: 'Маршруты парка «Открытый» открыты', ageHours: HOURS(10) });
      await alertRow({ type: 'park_closure', externalId: feedId('u6'), parks: ['a2-u-live'], title: seasonal('Живой'), ageHours: HOURS(25), leftHours: -HOURS(4) });
      await alertRow({ type: 'park_closure', externalId: 'manual-a2-u-live', parks: ['a2-u-live'], title: 'Приостановлено посещение маршрутов в природном парке «Живой» из-за циклона', ageHours: 6, leftHours: 24 });
      await alertRow({ type: 'park_closure', externalId: feedId('u7'), parks: ['a2-u-old'], title: seasonal('Старый'), ageHours: HOURS(130), leftHours: -HOURS(100) });
      await alertRow({ type: 'park_closure', externalId: 'manual-a2-u-manual', parks: ['a2-u-manual'], title: seasonal('Ручной'), ageHours: HOURS(25), leftHours: -HOURS(4) });
      // Дорожное ограничение уровня 1 у второго места — жёлтого не даёт.
      await alertRow({ type: 'road_closure', externalId: 'visitkamchatka/2026-11-05/ta2road', parks: null, title: 'Проезд по пропускам (тест)', ageHours: 2, leftHours: 48, severity: 1, lat: ROAD_PLACE.lat, lng: ROAD_PLACE.lng });

      const events: Array<{ entityId: string | null; decisionReason?: string; details?: Record<string, unknown> }> = [];
      const record = async (e: { entityId: string | null; decisionReason?: string; details?: Record<string, unknown> }) => { events.push(e); };
      const res = await markParkStatusUnknown(q, record);
      const mine = (list: string[]) => list.filter((s) => s.startsWith('a2-'));
      expect(mine(res.unknown)).toEqual(['a2-u-season']);
      expect(mine(res.started)).toEqual(['a2-u-season']);
      const rows = (await pool.query<{ external_id: string }>(`SELECT external_id FROM external_alerts WHERE external_id LIKE 'park-unknown/a2-%'`)).rows;
      expect(rows.map((r) => r.external_id)).toEqual(['park-unknown/a2-u-season']);

      const u = (await pool.query<{
        id: string; alert_type: string; severity: number; title: string; description: string; parks: string[]; zones: string[];
        same_base: boolean; live: boolean; ttl_ok: boolean; source_url: string;
      }>(
        `SELECT u.id::text AS id, u.alert_type, u.severity::int AS severity, u.title, u.description, u.affected_parks AS parks,
                u.affected_zones AS zones, u.source_url,
                (u.created_at = b.created_at AND u.last_published_at = b.created_at) AS same_base,
                u.expires_at > (NOW() AT TIME ZONE 'UTC') AS live,
                u.expires_at <= (NOW() AT TIME ZONE 'UTC') + INTERVAL '25 hours' AS ttl_ok
           FROM external_alerts u, external_alerts b
          WHERE u.external_id = 'park-unknown/a2-u-season' AND b.id::text = $1`, [basis],
      )).rows[0]!;
      expect(u).toMatchObject({ alert_type: 'park_status_unknown', severity: 1, parks: ['a2-u-season'], zones: [], same_base: true, live: true, ttl_ok: true });
      expect(u.title).toMatch(/^Статус парка «Сезонный» не известен: последняя сезонная сводка от \d{2}\.\d{2}$/);
      expect(u.description).toMatch(/сообщала о закрытии маршрутов на межсезонье; сводку об открытии в лентах, которые читает Ведар, мы не нашли\. Перед выходом уточните у дирекции парка\./);
      expect(events.some((e) => e.entityId === u.id && e.details?.basis_id === basis)).toBe(true);

      // Привязка — парком, не зоной: место парка — да, город той же зоны — нет.
      expect(await coveredBy(u.id)).toContain(SEASON_PLACE.id);
      expect(await coveredBy(u.id)).not.toContain(CITY.id);
      expect(await zonalFor(u.id, SEASON_PLACE.id)).toBe(false);

      await recomputeStatus();
      const season = await statusOf(SEASON_PLACE.ark);
      expect(season.status).toBe('yellow');
      expect(season.alerts).toContain(u.title);
      expect(season.sev).toBe(1);
      const road = await statusOf(ROAD_PLACE.ark);
      expect(road.alerts).toContain('Проезд по пропускам (тест)');
      expect(road.status, 'уровень 1 прочих родов места жёлтым не стал').toBe('green');

      // Повтор прохода — то же основание, ничего не начато.
      const again = await markParkStatusUnknown(q, record);
      expect(mine(again.started)).toEqual([]);
      expect(mine(again.unknown)).toEqual(['a2-u-season']);
    }, 30_000);

    it('снятое админом не воскресает при том же основании; новое основание возвращает; открытие гасит — и место снова зелёное', async () => {
      const record = async () => undefined;
      // Админ снял строку «не знаю» (DELETE /api/admin/external-alerts/[id]).
      await pool.query(
        `UPDATE external_alerts SET expires_at = (NOW() AT TIME ZONE 'UTC'), ended_by = 'admin' WHERE external_id = 'park-unknown/a2-u-season'`,
      );
      const held = await markParkStatusUnknown(q, record);
      expect(held.held_by_admin).toContain('a2-u-season');
      expect(held.unknown).not.toContain('a2-u-season');
      const deadRow = async () => (await pool.query<{ live: boolean; ended_by: string | null }>(
        `SELECT expires_at > (NOW() AT TIME ZONE 'UTC') AS live, ended_by FROM external_alerts WHERE external_id = 'park-unknown/a2-u-season'`,
      )).rows[0];
      expect(await deadRow()).toEqual({ live: false, ended_by: 'admin' });

      // Новая сезонная сводка, тоже истёкшая, — новое основание: «не знаю» вернулось.
      await alertRow({
        type: 'park_closure', externalId: 'visitkamchatka/2026-11-03/ta2u8', parks: ['a2-u-season'],
        title: 'Маршруты природного парка «Сезонный» закрыты на период межсезонья', ageHours: HOURS(22), leftHours: -1,
      });
      const back = await markParkStatusUnknown(q, record);
      expect(back.started).toContain('a2-u-season');
      expect(await deadRow()).toEqual({ live: true, ended_by: null });

      // Сводка об открытии после основания — условие кончилось, строка гаснет сама.
      await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-05/oa2open3', parks: ['a2-u-season'], title: 'Маршруты парка «Сезонный» открыты', ageHours: 6 });
      const gone = await markParkStatusUnknown(q, record);
      expect(gone.ended).toContain('a2-u-season');
      expect(gone.unknown).not.toContain('a2-u-season');
      expect(await deadRow()).toEqual({ live: false, ended_by: null });

      await recomputeStatus();
      const season = await statusOf(SEASON_PLACE.ark);
      expect(season.status).toBe('green');
      expect(season.alerts.some((t) => t.startsWith('Статус парка'))).toBe(false);
    }, 30_000);

    // Журнал решений — в эту же базу: отмена открытия находит тронутые
    // закрытия по нему (rejectParkReopening), и копия журнала в памяти судила
    // бы копию.
    const ledger = async (e: { entityId: string | null; eventType: string; actorType: string; actorId?: string; decisionReason?: string; details?: Record<string, unknown> }) => {
      await pool.query(
        `INSERT INTO safety_decision_events (entity_id, event_type, actor_type, actor_id, decision_reason, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.entityId, e.eventType, e.actorType, e.actorId ?? null, e.decisionReason ?? null, JSON.stringify(e.details ?? {})],
      );
    };

    it('ложное открытие отклоняется: проходы его не читают, погашенное закрытие снова живое, суженное — с парками (ревью 06.11)', async () => {
      const A = 'a2-rj-a';
      const B = 'a2-rj-b';
      const TITLE = 'Маршруты природных парков закрыты на период межсезонья';
      const full = await alertRow({ type: 'park_closure', externalId: feedId('rj1'), parks: [A], title: TITLE, ageHours: 72 });
      const partial = await alertRow({ type: 'park_closure', externalId: feedId('rj2'), parks: [A, B], title: TITLE, ageHours: 72 });
      const before = (await pool.query<{ e: string }>(`SELECT expires_at::text AS e FROM external_alerts WHERE id::text = $1`, [full])).rows[0]!.e;
      const opening = await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-05/oa2rj', parks: [A], title: 'Маршруты парка открыты', ageHours: 24 });
      // Другое, не отклонённое открытие в окне: проход идёт дальше счёта
      // открытий, и отклонённое обязано отсеиваться в самом отборе.
      await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-05/oa2rjother', parks: ['a2-rj-other'], title: 'Маршруты другого парка открыты', ageHours: 20 });

      const applied = await applyParkReopenings(q, ledger);
      expect(applied.ended + applied.narrowed).toBe(2);
      expect(await state(full)).toEqual({ parks: [A], live: false, ended_by: 'reopening' });
      expect(await state(partial)).toEqual({ parks: [B], live: true, ended_by: null });

      const res = await rejectParkReopening(q, opening, ledger);
      expect(res.rejected).toBe(true);
      expect([...res.restored_ids].sort()).toEqual([full, partial].sort());
      expect(await state(opening)).toMatchObject({ ended_by: 'admin' });
      // Погашенное — живое с прежним сроком, суженное — с возвращённым парком.
      expect(await state(full)).toEqual({ parks: [A], live: true, ended_by: null });
      expect((await pool.query<{ e: string }>(`SELECT expires_at::text AS e FROM external_alerts WHERE id::text = $1`, [full])).rows[0]!.e).toBe(before);
      expect(await state(partial)).toEqual({ parks: [B, A], live: true, ended_by: null });

      // Отклонённое больше не читает ни один проход: повтор ничего не снимает.
      const again = await applyParkReopenings(q, ledger);
      expect(again.ended + again.narrowed).toBe(0);
      expect(await state(full)).toEqual({ parks: [A], live: true, ended_by: null });
      // Второй раз — уже отклонено; строка не открытие — тоже нет.
      expect((await rejectParkReopening(q, opening, ledger)).rejected).toBe(false);
      expect((await rejectParkReopening(q, full, ledger)).rejected).toBe(false);

      // «Не знаю» отклонённое открытие тоже не глушит: сезонное закрытие
      // истекло, открытие после него было, но его отклонили.
      await alertRow({ type: 'park_closure', externalId: feedId('rj3'), parks: ['a2-u-rejected'], title: 'Маршруты природного парка «Отклонённый» закрыты на период межсезонья', ageHours: HOURS(25), leftHours: -HOURS(4) });
      const late = await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-04/oa2rj2', parks: ['a2-u-rejected'], title: 'Маршруты парка «Отклонённый» открыты', ageHours: HOURS(2) });
      expect((await markParkStatusUnknown(q, ledger)).unknown).not.toContain('a2-u-rejected');
      expect((await rejectParkReopening(q, late, ledger)).rejected).toBe(true);
      expect((await markParkStatusUnknown(q, ledger)).unknown).toContain('a2-u-rejected');
    }, 30_000);

    it('более поздняя сводка о закрытии между чтением и записью прохода — парк не снимается (сверка основания)', async () => {
      const A = 'a2-rc-a';
      const B = 'a2-rc-b';
      const closure = await alertRow({ type: 'park_closure', externalId: feedId('rc1'), parks: [A, B], title: 'Маршруты природных парков закрыты на период межсезонья', ageHours: 72 });
      await alertRow({ type: 'park_reopening', externalId: 'visitkamchatka/2026-11-05/oa2rc', parks: [A], title: 'Маршруты парка открыты', ageHours: 24 });
      let reads = 0;
      const racing = async <T,>(sql: string, params: unknown[]) => {
        const r = await pool.query(sql, params);
        // То, что делает saveEvent с повтором сводки, опубликованным ПОСЛЕ
        // открытия: основание сдвигается вперёд.
        if (++reads === 2) {
          await pool.query(
            `UPDATE external_alerts SET last_published_at = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour' WHERE id::text = $1`, [closure],
          );
        }
        return r as unknown as { rows: T[] };
      };
      const res = await applyParkReopenings(racing, ledger);
      expect(res.changed_ids).not.toContain(closure);
      expect(await state(closure)).toEqual({ parks: [A, B], live: true, ended_by: null });
    }, 30_000);

    it('«не знаю» после сезонного и оперативного закрытия — дата СЕЗОННОЙ сводки, а не последней', async () => {
      await alertRow({ type: 'park_closure', externalId: feedId('tw1'), parks: ['a2-u-twice'], title: 'Маршруты природного парка «Двойной» закрыты на период межсезонья', ageHours: HOURS(25), leftHours: -HOURS(4) });
      await alertRow({ type: 'park_closure', externalId: feedId('tw2'), parks: ['a2-u-twice'], title: 'Приостановлено посещение маршрутов в природном парке «Двойной» из-за циклона', ageHours: HOURS(5), leftHours: -HOURS(3) });
      const res = await markParkStatusUnknown(q, ledger);
      expect(res.unknown).toContain('a2-u-twice');
      const row = (await pool.query<{ title: string; base_days: number }>(
        `SELECT title, round(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - created_at)) / 86400)::int AS base_days
           FROM external_alerts WHERE external_id = 'park-unknown/a2-u-twice'`,
      )).rows[0]!;
      expect(row.base_days, 'основание — сезонная сводка 25 суток назад, не циклон 5 суток назад').toBe(25);
      expect(row.title).toMatch(/^Статус парка «Двойной» не известен: последняя сезонная сводка от /);
    }, 30_000);

    it('строку «не знаю», заведённую соседним прогоном после нашего чтения, наш проход не гасит', async () => {
      // Живая строка без основания, которую наш проход прочитал: её он гасит
      // законно — значит, гашение в этом прогоне идёт, и проверка ниже не
      // пустая.
      await pool.query(
        `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                      created_at, last_published_at, expires_at, external_id)
         VALUES ('park_status_unknown', 1, 'Статус парка «Прежний» не известен (тест)', '', '{}', ARRAY['a2-u-stale'],
                 (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day',
                 'park-unknown/a2-u-stale')`,
      );
      let reads = 0;
      const racing = async <T,>(sql: string, params: unknown[]) => {
        const r = await pool.query(sql, params);
        // Пятый запрос прохода — чтение существующих строк «не знаю»; сразу
        // после него соседний прогон заводит свою.
        if (++reads === 5) {
          await pool.query(
            `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                          created_at, last_published_at, expires_at, external_id)
             VALUES ('park_status_unknown', 1, 'Статус парка «Гонка» не известен (тест)', '', '{}', ARRAY['a2-u-race'],
                     (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day',
                     'park-unknown/a2-u-race')`,
          );
        }
        return r as unknown as { rows: T[] };
      };
      const res = await markParkStatusUnknown(racing, ledger);
      expect(res.ended).toContain('a2-u-stale');
      const live = (await pool.query<{ live: boolean }>(
        `SELECT expires_at > (NOW() AT TIME ZONE 'UTC') AS live FROM external_alerts WHERE external_id = 'park-unknown/a2-u-race'`,
      )).rows[0];
      expect(live?.live).toBe(true);
    }, 30_000);
  });

  describe('планер видит закрытие парка на днях плана (разбор 06.11)', () => {
    // До этой правки движок планера читал из тревог только извержение и
    // дорогу: день в закрытом Налычево собирался как обычный — и на сайте, и у
    // агента. Привязка дня к парку — тем же PARK_SCOPED_SQL, что красит места.
    const q = async <T,>(sql: string, params: unknown[]) => (await pool.query(sql, params)) as unknown as { rows: T[] };
    const ids: { op?: string; viaRoute?: string; viaPlace?: string; outside?: string; closure?: string; unknown?: string } = {};
    const OUTSIDE_ROUTE_ID = 'd0000000-0000-4000-8000-0000000000f1';
    const SEASONAL = 'Маршруты природного парка «Налычево» закрыты на период межсезонья (тест планера)';

    beforeAll(async () => {
      ids.op = (await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact) VALUES ('Оператор планера (тест)', 'operator', '{}') RETURNING id::text AS id`,
      )).rows[0]!.id;
      await pool.query(
        `INSERT INTO kamchatka_routes (id, category, title, zone, is_visible)
         VALUES ($1, 'trekking', 'Прогулка по набережной (тест планера)', 'avachinsky', TRUE)`,
        [OUTSIDE_ROUTE_ID],
      );
      const tour = async (title: string, routeId: string | null, placeId: string | null) => (await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, route_id, main_place_id) VALUES ($1::uuid, $2, $3::uuid, $4) RETURNING id::text AS id`,
        [ids.op, title, routeId, placeId],
      )).rows[0]!.id;
      ids.viaRoute = await tour('Тур по маршруту парка (тест)', PARK_ROUTE_ID, null);
      ids.viaPlace = await tour('Тур к месту парка (тест)', null, ON_PARK_ROUTE.id);
      ids.outside = await tour('Тур по городу (тест)', OUTSIDE_ROUTE_ID, CITY.id);
      // Сводка двое суток назад, срок — 21 сутки вперёд (держание A1).
      ids.closure = (await pool.query<{ id: string }>(
        `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                      created_at, last_published_at, expires_at, source_url, external_id)
         VALUES ('park_closure', 2, $1, '', '{}', ARRAY['nalychevo'],
                 (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 days', (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 days',
                 (NOW() AT TIME ZONE 'UTC') + INTERVAL '19 days', 'https://t.me/s/visitkamchatka41/1', 'visitkamchatka/2026-11-04/tplanner')
         RETURNING id::text AS id`,
        [SEASONAL],
      )).rows[0]!.id;
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM external_alerts WHERE id::text = ANY($1::text[])`, [[ids.closure, ids.unknown].filter(Boolean)]);
      await pool.query(`DELETE FROM operator_tours WHERE id::text = ANY($1::text[])`, [[ids.viaRoute, ids.viaPlace, ids.outside]]);
      await pool.query(`DELETE FROM kamchatka_routes WHERE id = $1::uuid`, [OUTSIDE_ROUTE_ID]);
      await pool.query(`DELETE FROM partners WHERE id = $1::uuid`, [ids.op]);
    });

    it('запрос находит маршрут дня, тур по маршруту и тур по главному месту — и не находит город', async () => {
      const rows = await loadPlanParkAlerts(q, {
        routeIds: [PARK_ROUTE_ID, OUTSIDE_ROUTE_ID],
        tourIds: [ids.viaRoute!, ids.viaPlace!, ids.outside!],
      });
      const mine = rows.filter((r) => r.alert_id === ids.closure);
      const refs = mine.map((r) => `${r.ref_kind}:${r.ref_id}`).sort();
      expect(refs).toEqual([`route:${PARK_ROUTE_ID}`, `tour:${ids.viaRoute}`, `tour:${ids.viaPlace}`].sort());
      expect(mine.every((r) => r.alert_type === 'park_closure' && r.title === SEASONAL)).toBe(true);
    });

    it('план: день в парке — закрытие первой строкой дня и критическим предупреждением; после срока — «статус не известен»; город — ничего', async () => {
      const dayIso = (offset: number) => new Date(Date.now() + 12 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
      const days = [
        { day: 1, title: 'Таловская тропа', dayWarnings: ['Возьмите треккинговые палки.'], routeId: PARK_ROUTE_ID },
        { day: 2, title: 'Тур по маршруту парка', dayWarnings: [], realTour: { tourId: ids.viaRoute! } },
        { day: 3, title: 'Тур по городу', dayWarnings: [], realTour: { tourId: ids.outside! } },
      ];
      // День 2 — через месяц: закрытие к тому дню уже истечёт, но оно сезонное.
      const dates: Record<number, string> = { 1: dayIso(1), 2: dayIso(30), 3: dayIso(2) };
      const res = await applyPlanParkStatus(days, (n) => dates[n] ?? null, q);
      expect(res.unread).toBe(false);
      expect(days[0]!.dayWarnings[0]).toMatch(/^Закрытие парка по сводке от \d{2}\.\d{2}: «Маршруты природного парка «Налычево» закрыты/);
      expect(days[0]!.dayWarnings[1]).toBe('Возьмите треккинговые палки.');
      expect(days[1]!.dayWarnings[0]).toMatch(/^Статус парка на этот день не известен: сводка от \d{2}\.\d{2} сообщала о закрытии маршрутов без даты открытия/);
      expect(days[2]!.dayWarnings).toEqual([]);
      expect(res.warnings[0]).toMatchObject({ severity: 'critical' });
      expect(res.warnings[0]!.message).toMatch(/^День 1: Закрытие парка/);
      expect(res.warnings.some((w) => w.severity === 'important' && /^День 2: Статус парка на этот день не известен/.test(w.message))).toBe(true);
    });

    it('«статус парка не известен» тоже доходит до дня плана; отказ чтения — «проверить не удалось», а не тишина', async () => {
      ids.unknown = (await pool.query<{ id: string }>(
        `INSERT INTO external_alerts (alert_type, severity, title, description, affected_zones, affected_parks,
                                      created_at, last_published_at, expires_at, external_id)
         VALUES ('park_status_unknown', 1, 'Статус парка «Налычево» не известен: последняя сезонная сводка от 01.11 (тест)', '', '{}', ARRAY['nalychevo'],
                 (NOW() AT TIME ZONE 'UTC') - INTERVAL '25 days', (NOW() AT TIME ZONE 'UTC') - INTERVAL '25 days',
                 (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day', 'park-unknown/planner-test')
         RETURNING id::text AS id`,
      )).rows[0]!.id;
      const days = [{ day: 1, title: 'Тур к месту парка', dayWarnings: [] as string[], realTour: { tourId: ids.viaPlace! } }];
      await applyPlanParkStatus(days, () => null, q);
      expect(days[0]!.dayWarnings.some((w) => w.startsWith('Статус парка «Налычево» не известен: последняя сезонная сводка от 01.11 (тест). Уточните у дирекции парка'))).toBe(true);

      const broken = async <T,>(): Promise<{ rows: T[] }> => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); };
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failed = await applyPlanParkStatus([{ day: 1, title: 'x', dayWarnings: [], routeId: PARK_ROUTE_ID }], () => null, broken);
      expect(failed.unread).toBe(true);
      expect(failed.warnings).toEqual([{ severity: 'important', message: PARK_STATUS_UNREAD_NOTE }]);
      expect(err.mock.calls.some((c) => c.join(' ').includes('42P01'))).toBe(true);
      err.mockRestore();
    });
  });
});
