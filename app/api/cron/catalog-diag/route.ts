/**
 * GET /api/cron/catalog-diag — почему публичный каталог отвечает 503.
 *
 * Ночью 15.08 `/api/routes` начал отдавать 503 с телом «Ошибка базы
 * данных. Проверьте DATABASE_URL в env.» — и на выборке из двух тысяч
 * записей, и на пяти. При этом health отвечает ok:true, то есть
 * подключение живо, а сообщение вводит в заблуждение.
 *
 * Диагностика идёт от простого к сложному и возвращает ТЕКСТ ошибки
 * Postgres на первом же упавшем шаге: пустой VIEW, счёт по нему, выборка
 * колонок каталога, join'ы карточек. По шагу видно, что именно сломано —
 * гадать по коду 503 бессмысленно.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { queryCatalog } from '@/lib/routes/catalog-query';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STEPS: Array<{ name: string; sql: string }> = [
  { name: 'select 1', sql: 'SELECT 1 AS ok' },
  { name: 'places жив', sql: 'SELECT COUNT(*)::int AS n FROM places' },
  { name: 'kamchatka_routes жив', sql: 'SELECT COUNT(*)::int AS n FROM kamchatka_routes' },
  { name: 'VIEW читается', sql: 'SELECT COUNT(*)::int AS n FROM agent_route_knowledge' },
  {
    name: 'колонки каталога из VIEW',
    sql: `SELECT ark.id, ark.route_dedupe_key, ark.kind, ark.category, ark.location_type,
                 ark.activity_type, ark.title, ark.description, ark.lat, ark.lng,
                 ark.source_url, ark.source_name, ark.payload, ark.created_at
          FROM agent_route_knowledge ark LIMIT 3`,
  },
  {
    name: 'join фото и статуса',
    sql: `SELECT ark.id,
                 (ari.route_id IS NOT NULL AND ari.model IN ('wikimedia','manual-upload')) AS has_real_image,
                 lrs.is_open
          FROM agent_route_knowledge ark
          LEFT JOIN ai_route_images ari ON ari.route_id = ark.id
          LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = ark.id
          LIMIT 3`,
  },
  {
    name: 'сортировка каталога по умолчанию',
    sql: `SELECT ark.id FROM agent_route_knowledge ark
          WHERE ark.kind = 'place' AND ark.lat IS NOT NULL AND ark.lng IS NOT NULL
          ORDER BY title ASC LIMIT 50`,
  },
];

/**
 * Ветка карточки маршрута — отдельным списком, и он выполняется ВСЕГДА.
 *
 * Список выше идёт по нарастанию сложности и обрывается на первом падении:
 * там это верно, следующий шаг сложнее упавшего. Но карточка маршрута —
 * не «шаг сложнее», а другая ветка, и обрывать её по чужому падению значит
 * повторить ошибку 16.08: тогда диагностика проверила `kind=place`, а падал
 * `kind=route`, и слепое пятно осталось незамеченным.
 */
const DETAIL_STEPS: Array<{ name: string; sql: string; showRows?: boolean }> = [
  /**
   * Смоук 16.08 увидел у настоящего маршрута «0 точек с координатами», но
   * сказать, дефект это данных или упавший запрос, было нельзя: в роуте
   * стоял `.catch(() => ({ rows: [] }))`. Здесь тот же JOIN без глушителя.
   */
  {
    name: 'точки маршрута (тот же JOIN, что в карточке)',
    sql: `SELECT rw.position, p.name AS place_name, p.lat AS place_lat, p.lng AS place_lng,
                 sp.altitude_m
          FROM route_waypoints rw
          JOIN places p ON p.id = rw.place_id
          LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
          WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
          ORDER BY rw.position
          LIMIT 5`,
  },
  {
    // Если запрос жив, а координат нет — это дефект ДАННЫХ, и цифра
    // отвечает на вопрос сразу: сколько связей маршрут-точка вообще имеют
    // координаты. Ноль здесь значит совсем не то, что упавший запрос выше.
    name: 'сколько точек маршрутов имеют координаты',
    sql: `SELECT COUNT(*)::int AS n
          FROM route_waypoints rw
          JOIN places p ON p.id = rw.place_id
          WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL`,
  },
  {
    /**
     * Кандидаты в фикстуру смоука — по всем критериям сразу, из БД.
     *
     * Смоук по HTTP видит только точки и род линии; `merged_into`,
     * видимость и происхождение геометрии ему не видны. Выбирать фикстуру
     * по одному удачному прогону нельзя — маршрут, годный сегодня, может
     * исчезнуть от ближайшей чистки, и контракт начнёт краснеть без всякой
     * регрессии.
     *
     * Отсюда список берётся ДО мержа: тогда переменная задаётся заранее и
     * искусственного красного в истории релизов не возникает.
     *
     * id отдаётся в том же пространстве, что понимает /api/routes/[id]:
     * COALESCE(ark_id, id) — иначе фикстура не откроется.
     */
    name: 'кандидаты в фикстуру смоука (id для SMOKE_ROUTE_ID)',
    // Единственный шаг, чьи СТРОКИ и есть ответ: остальным довольно факта
    // «запрос жив». Здесь нужны сами id, иначе шаг бесполезен.
    showRows: true,
    sql: `SELECT COALESCE(kr.ark_id, kr.id)::text AS id,
                 kr.title,
                 COUNT(*)::int AS points,
                 COALESCE(kr.geometry->>'source', 'нет геометрии') AS geometry_source
          FROM kamchatka_routes kr
          JOIN route_waypoints rw ON rw.route_id = kr.id
          JOIN places p ON p.id = rw.place_id
          WHERE kr.is_visible = TRUE
            AND p.is_visible = TRUE
            AND p.merged_into_id IS NULL
            AND p.lat IS NOT NULL AND p.lng IS NOT NULL
          GROUP BY kr.id, kr.ark_id, kr.title, kr.geometry
          HAVING COUNT(*) >= 2
          -- Снятый трек предпочтительнее синтетики: такая фикстура переживёт
          -- пересборку геометрии, а синтетическая может смениться.
          ORDER BY (kr.geometry->>'source' = 'waypoints_synthetic') ASC,
                   COUNT(*) DESC
          LIMIT 5`,
  },
  {
    name: 'живой статус точек (ветка оперативных ограничений)',
    sql: `SELECT rs.is_open, rs.alert_message, rs.active_alerts, rs.alert_severity
          FROM route_waypoints rw
          JOIN places p ON p.id = rw.place_id
          JOIN location_real_time_status rs ON rs.agent_route_id = p.ark_id
          LIMIT 5`,
  },
];

/**
 * Поля ошибки Postgres как они есть.
 *
 * Одного `message` мало: «column reference is_visible is ambiguous» ещё
 * читается, а вот отличить ошибку синтаксиса (42601) от несуществующей
 * колонки (42703) и от нарушения типов (42883) по тексту — гадание.
 * SQLSTATE называет род поломки однозначно, `position` указывает место
 * в запросе. Всё это доступно только внутри закрытого контура.
 */
function pgErrorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const e = err as Error & {
    code?: string; detail?: string; hint?: string; position?: string; where?: string;
  };
  return {
    error: e.message.slice(0, 400),
    sqlstate: e.code,
    detail: e.detail?.slice(0, 300),
    hint: e.hint?.slice(0, 300),
    position: e.position,
    where: e.where?.slice(0, 300),
    stack: (e.stack ?? '').split('\n').slice(1, 4).join(' | '),
  };
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  interface DiagStep { step: string; ok: boolean; rows?: number; [k: string]: unknown }
  const results: DiagStep[] = [];

  for (const step of STEPS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await pool.query(step.sql);
      results.push({ step: step.name, ok: true, rows: res.rowCount ?? 0 });
    } catch (err) {
      results.push({ step: step.name, ok: false, ...pgErrorFields(err) });
      break; // дальше идти незачем: следующий шаг сложнее упавшего
    }
  }

  // Ветка карточки маршрута — независимо от того, что стало с каталогом.
  for (const step of DETAIL_STEPS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await pool.query(step.sql);
      results.push({
        step: step.name,
        ok: true,
        rows: res.rowCount ?? 0,
        // У счётного шага важна сама цифра, а не число строк ответа.
        ...(res.rows[0]?.n != null ? { count: res.rows[0].n } : {}),
        ...(step.showRows ? { candidates: res.rows } : {}),
      });
    } catch (err) {
      results.push({ step: step.name, ok: false, ...pgErrorFields(err) });
    }
  }

  /**
   * Вызовы queryCatalog теми же аргументами, что приходят с прода —
   * от простого к сложному, чтобы ветка с ошибкой называла себя сама.
   *
   * Смоук 16.08 упал на `kind=route&has_waypoints=true`, а прежняя
   * диагностика проверяла только `kind=place`: то есть подтверждала
   * здоровье НЕ той ветки, которая падает. Отсюда правило — форма запроса
   * в диагностике обязана совпадать с той, что сломалась, иначе зелёный
   * ответ означает лишь, что мы спросили не о том.
   *
   * Разделение на три шага отвечает на конкретный вопрос: сломан ли
   * каталог вообще, ветка has_waypoints или именно двухточечный предикат
   * (ca70f8a3). Это заменяет сверку по времени мержа, которая ничего не
   * доказывает.
   */
  const CATALOG_CALLS: Array<{ name: string; filters: Record<string, unknown> }> = [
    { name: 'queryCatalog kind=place (как проба 84)', filters: { kind: 'place', limit: 5, page: 1 } },
    { name: 'queryCatalog kind=route без has_waypoints', filters: { kind: 'route', limit: 10, page: 1, sort: 'recommended' } },
    { name: 'queryCatalog kind=route + has_waypoints (форма смоука)', filters: { kind: 'route', limit: 10, page: 1, sort: 'recommended', has_waypoints: 'true' } },
  ];

  for (const call of CATALOG_CALLS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await queryCatalog(call.filters as never);
      results.push({ step: call.name, ok: true, rows: res.items.length });
    } catch (err) {
      results.push({ step: call.name, ok: false, ...pgErrorFields(err) });
      // Не прерываемся: важно знать, падают ли ВСЕ ветки или только одна —
      // это и есть ответ про регрессию.
    }
  }

  const failed = results.filter(r => !r.ok);

  // Вердикт называет ветку, а не только первый упавший шаг: «падает всё» и
  // «падает одна ветка» чинятся по-разному, и именно это различие отвечает
  // на вопрос о регрессии.
  const verdict = failed.length === 0
    ? 'все шаги прошли — поломка не в этих запросах'
    : failed.length === results.length
      ? 'падают все шаги — общая поломка доступа к БД'
      : `падает ${failed.length} из ${results.length}: ${failed.map(f => `«${f.step}»`).join(', ')}`;

  return NextResponse.json({
    success: true,
    release: process.env.RELEASE_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    verdict,
    steps: results,
  });
}
