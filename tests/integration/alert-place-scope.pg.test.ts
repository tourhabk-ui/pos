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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { createTestDatabase } from '../helpers/pg-schema';

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
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      // external_id отдельным параметром, а не `$2 || '-' || ...`: у параметра
      // в конкатенации нет якоря типа, и Postgres отвечает 42P08
      // «inconsistent types deduced» — первая редакция этого теста на нём и
      // упала, ровно как описано в CLAUDE.md про запрос, который не
      // выполнялся никогда.
      `INSERT INTO external_alerts
         (alert_type, severity, title, description, affected_zones, created_at, expires_at,
          source_url, external_id, lat, lng, volcano_name, volcano_ark_id, affected_parks, magnitude)
       VALUES ($1, 2, $2, $9, $3, NOW(), NOW() + INTERVAL '1 day',
               'https://example.test', $8, $4, $5, $6, $7, $10, $11)
       RETURNING id::text AS id`,
      [fields.type, fields.title, fields.zones, fields.lat ?? null, fields.lng ?? null,
        fields.volcanoName ?? null, fields.volcanoArk ?? null,
        `${fields.type}-${Math.random().toString(36).slice(2)}`,
        // Заголовок и описание — РАЗНЫМИ параметрами: title это varchar, а
        // description text, и один $2 на оба даёт тот же 42P08.
        fields.title,
        fields.parks ?? null,
        fields.magnitude ?? null],
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
      expect(by.get(FAR_NORTH.id)?.reached_by).toEqual(['krai_wide', 'meteo_north', 'meteo_south']);
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
  });
});
