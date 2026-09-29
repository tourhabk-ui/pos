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
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[alert-place-scope.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'alert_scope_test';
/** Первая миграция после baseline (снимок прода 2026-08-15, последняя в нём — 862). */
const FIRST_AFTER_BASELINE = 863;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Настоящие координаты: между конусами ~75 км, то есть больше порога 25. */
const SHIVELUCH = { id: 'place-shiveluch-test', ark: 'b0000000-0000-4000-8000-000000000001', lat: 56.653, lng: 161.360 };
const KLYUCHEVSKOY = { id: 'place-klyuchevskoy-test', ark: 'b0000000-0000-4000-8000-000000000002', lat: 56.056, lng: 160.642 };
/** Место у подножия Шивелуча: ближе 25 км, привязки в таблице нет. */
const NEAR_SHIVELUCH = { id: 'place-near-shiveluch-test', ark: 'b0000000-0000-4000-8000-000000000003', lat: 56.700, lng: 161.300 };
/** Место в той же зоне, но далеко и без связи с вулканом. */
const FAR_NORTH = { id: 'place-far-north-test', ark: 'b0000000-0000-4000-8000-000000000004', lat: 57.800, lng: 160.000 };
/** Привязанное к Шивелучу поимённо (place_volcano_links), но за 120 км. */
const LINKED_FAR = { id: 'place-linked-far-test', ark: 'b0000000-0000-4000-8000-000000000005', lat: 55.600, lng: 161.900 };

withPg('кого накрывает предупреждение', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await bootstrap.query(`CREATE DATABASE ${TEST_DB}`);
    await bootstrap.end();

    const dbUrl = withDatabase(PG_URL, TEST_DB);
    const env = { ...process.env, DATABASE_URL: dbUrl, DATABASE_SSL: 'false' };
    execFileSync('node', [join(process.cwd(), 'scripts', 'bootstrap-from-baseline.js')], { env, stdio: 'pipe' });
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    // Порог сравнивается ЧИСЛОМ: `name >= '863'` — сравнение текста, и
    // '1000_...' >= '863' ложно.
    await pool.query(
      `DELETE FROM _migrations WHERE (substring(name from '^[0-9]+'))::bigint >= $1`,
      [FIRST_AFTER_BASELINE],
    );
    execFileSync('npx', ['tsx', join(process.cwd(), 'lib', 'database', 'migrate.ts')], { env, stdio: 'pipe' });

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
  }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      // external_id отдельным параметром, а не `$2 || '-' || ...`: у параметра
      // в конкатенации нет якоря типа, и Postgres отвечает 42P08
      // «inconsistent types deduced» — первая редакция этого теста на нём и
      // упала, ровно как описано в CLAUDE.md про запрос, который не
      // выполнялся никогда.
      `INSERT INTO external_alerts
         (alert_type, severity, title, description, affected_zones, created_at, expires_at,
          source_url, external_id, lat, lng, volcano_name, volcano_ark_id)
       VALUES ($1, 2, $2, $9, $3, NOW(), NOW() + INTERVAL '1 day',
               'https://example.test', $8, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [fields.type, fields.title, fields.zones, fields.lat ?? null, fields.lng ?? null,
        fields.volcanoName ?? null, fields.volcanoArk ?? null,
        `${fields.type}-${Math.random().toString(36).slice(2)}`,
        // Заголовок и описание — РАЗНЫМИ параметрами: title это varchar, а
        // description text, и один $2 на оба даёт тот же 42P08.
        fields.title],
    );
    return rows[0].id;
  }

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
});
