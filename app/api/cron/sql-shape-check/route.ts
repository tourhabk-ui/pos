/**
 * GET /api/cron/sql-shape-check?secret=<CRON_SECRET>
 *
 * Перепись запросов формы «INSERT ... SELECT $n ... WHERE NOT EXISTS (... = $n)».
 * Ничего не выполняет и ничего не пишет.
 *
 * ЗАЧЕМ. 24.08 проба beacon-check показала, что приёмник маяка воронки не
 * записал НИ ОДНОГО события за всё время: PostgreSQL отвечал 42P08
 * «inconsistent types deduced for parameter $1». Причина не в правах и не в
 * данных, а в форме запроса: параметр стоит дважды — в списке SELECT, где
 * контекста типа нет, и в сравнении с колонкой, где тип есть. Выводы
 * расходятся (text против varchar), и запрос не выполняется никогда.
 *
 * Форма эта в репозитории не одна. Она — идиома: «вставь, если такого ещё
 * нет», атомарная замена паре SELECT+INSERT, и написана она в шести местах,
 * включая регистрацию партнёра и отзыв о жилье. Один и тот же дефект в
 * шести местах — это не шесть случайностей, а признак того, что искать надо
 * правилом, а не глазами (тот же вывод, что 19.08 по сердцебиениям кронов).
 *
 * Проба 202 (Ф5-хвост, route-endpoints) нашла ТОТ ЖЕ КОРЕНЬ в другой форме:
 * не WHERE NOT EXISTS, а обычный VALUES с ON CONFLICT, где один параметр
 * употреблён дважды — один раз «голым» (тип из колонки), один раз с явным
 * приведением (`$1::uuid`). Реестр держит и этот случай — критерий для
 * попадания сюда не форма запроса, а «один параметр, разное приведение».
 *
 * КАК ПРОВЕРЯЕТСЯ. `PREPARE` — и всё. Вывод типов параметров происходит на
 * разборе, ДО выполнения: запрос с расходящимся выводом не подготовится.
 * Ни одной строки не вставляется, транзакция не нужна, чужие данные не
 * трогаются. `DEALLOCATE ALL` в конце возвращает соединение в пул чистым.
 *
 * ПОЧЕМУ SQL СКОПИРОВАН, А НЕ ИМПОРТИРОВАН. Запросы живут внутри функций
 * своих роутов, вытащить их наружу — отдельная правка шести файлов, и её
 * цена выше пользы прямо сейчас. Расхождение копии с оригиналом сторожит
 * тест `sql-shape-check.test.ts`: он ищет каждый запрос в его файле по
 * скелету (без пробелов) и краснеет, если оригинал изменили, а копию нет.
 *
 * ПОЛНОТА РЕЕСТРА ДЕРЖИТСЯ ПРАВИЛОМ, А НЕ ВНИМАТЕЛЬНОСТЬЮ. Первая версия
 * реестра была собрана руками и честно объявляла себя неполной: запрос,
 * написанный завтра, в неё бы не попал. Теперь полноту сторожит
 * `tests/unit/sql-param-cast-shape.test.ts` — он вычитывает из исходников
 * ВСЕ запросы этой формы и краснеет, если хоть один не внесён сюда.
 *
 * Почему сторож не судит сам, а лишь требует внести в реестр: статикой тип
 * параметра не выводится. В `lib/places/aliases.ts` один и тот же параметр
 * сравнивается с `p.id::text`, а вставляется в `place_id` — правильное
 * приведение у двух его употреблений РАЗНОЕ, и требование «одинаковый тип
 * везде» пометило бы рабочий запрос как сломанный. Судить о выводе типов
 * может только сервер, поэтому приговор выносит PREPARE, а сторож лишь не
 * даёт запросу пройти мимо суда.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

export interface ShapeEntry {
  /** Имя для человека. */
  name: string;
  /** Файл, откуда запрос скопирован — по нему сторож сверяет копию. */
  source: string;
  sql: string;
}

export const SHAPES: ShapeEntry[] = [
  {
    name: 'маяк воронки',
    source: 'app/api/funnel/route.ts',
    sql: `INSERT INTO funnel_events (step, entity_id, visitor_hash)
       SELECT $1::varchar, $2::text, $3::varchar
        WHERE NOT EXISTS (
          SELECT 1 FROM funnel_events
           WHERE step = $1::varchar
             AND entity_id IS NOT DISTINCT FROM $2::text
             AND visitor_hash = $3::varchar
             AND created_at > NOW() - INTERVAL '60 minutes'
        )`,
  },
  {
    name: 'регистрация: профиль партнёра',
    source: 'app/api/auth/register/route.ts',
    sql: `INSERT INTO partners
             (user_id, name, category, contact, is_verified, rating, review_count, created_at, updated_at)
           SELECT $1::uuid, $2, $3::varchar, $4::jsonb, false, 0, 0, NOW(), NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM partners WHERE user_id = $1::uuid AND category = $3::varchar
           )`,
  },
  {
    name: 'профиль партнёра при входе',
    source: 'lib/auth/partner-profile.ts',
    sql: `INSERT INTO partners (user_id, name, category, contact, is_verified, rating, review_count, created_at, updated_at)
     SELECT $1::uuid, $2, $3::varchar, $4::jsonb, false, 0, 0, NOW(), NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM partners WHERE user_id = $1::uuid AND category = $3::varchar
     )
     RETURNING id`,
  },
  {
    name: 'отзыв о жилье (один на бронь)',
    source: 'app/api/accommodations/[id]/reviews/route.ts',
    sql: `INSERT INTO accommodation_reviews
         (user_id, accommodation_id, booking_id, overall_rating,
          cleanliness_rating, service_rating, location_rating, value_rating,
          title, comment, is_verified, is_visible)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, true
       WHERE NOT EXISTS (
         SELECT 1 FROM accommodation_reviews WHERE booking_id = $3
       )
       RETURNING id, created_at`,
  },
  {
    name: 'алиас места',
    source: 'lib/places/aliases.ts',
    sql: `INSERT INTO place_aliases (place_id, alias, source_name)
     SELECT $1, $2, $3
      WHERE NOT EXISTS (
        SELECT 1 FROM places p
         WHERE p.id::text = $1
           AND LOWER(TRIM(COALESCE(p.name, ''))) = LOWER(TRIM($2))
      )
     ON CONFLICT DO NOTHING`,
  },
  {
    name: 'служебный партнёр (проверка оплаты)',
    source: 'app/api/cron/payment-test-setup/route.ts',
    sql: `INSERT INTO partners (name, company_name, category, contact, contacts, commission_current, is_public, is_verified, external_source)
       SELECT $1::text, $1::text, 'operator', '{}'::jsonb, '{}'::jsonb, $2::numeric, false, false, 'service-payment-test'
        WHERE NOT EXISTS (SELECT 1 FROM partners WHERE name = $1::text)
       RETURNING id::text`,
  },
  {
    name: 'служебный тур (проверка оплаты)',
    source: 'app/api/cron/payment-test-setup/route.ts',
    sql: `INSERT INTO operator_tours (operator_id, title, base_price, is_active, is_published)
       SELECT $1::uuid, $2::text, $3::numeric, false, false
        WHERE NOT EXISTS (SELECT 1 FROM operator_tours WHERE title = $2::text AND deleted_at IS NULL)
       RETURNING id::text`,
  },
  {
    name: 'служебная бронь (проверка оплаты)',
    source: 'app/api/cron/payment-test-setup/route.ts',
    sql: `INSERT INTO operator_bookings
         (operator_tour_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, created_via)
       SELECT $1::bigint, CURRENT_DATE, 1, $2::numeric, $2::numeric, 'pending_payment', 'pending', 'service-payment-test'
        WHERE NOT EXISTS (
              SELECT 1 FROM operator_bookings
               WHERE operator_tour_id = $1::bigint AND deleted_at IS NULL AND paid_at IS NULL)
       RETURNING id::text`,
  },
  {
    name: 'новое место конечной точки маршрута (route-endpoints)',
    source: 'lib/import/route-endpoints-runner.ts',
    sql: `INSERT INTO places (id, ark_id, name, lat, lng, location_type, source_url, source_name, is_visible)
         VALUES ($1::text, $1::uuid, $2, $3::numeric, $4::numeric, 'other', $5, 'visitkamchatka.ru', true)
         ON CONFLICT (id) DO NOTHING`,
  },
  {
    name: 'перенос путевых точек при слиянии маршрутов',
    source: 'app/api/cron/route-family-merge/route.ts',
    sql: `INSERT INTO route_waypoints (route_id, place_id, position, link_kind, link_kind_at)
           SELECT l.id, rw.place_id,
                  COALESCE((SELECT MAX(x.position) FROM route_waypoints x WHERE x.route_id = l.id), 0)
                    + ROW_NUMBER() OVER (ORDER BY rw.position),
                  rw.link_kind, rw.link_kind_at
           FROM route_waypoints rw
           JOIN kamchatka_routes h ON h.id = rw.route_id AND h.id::text = $2
           JOIN kamchatka_routes l ON l.id::text = $1
           WHERE NOT EXISTS (
             SELECT 1 FROM route_waypoints x WHERE x.route_id = l.id AND x.place_id = rw.place_id
           )
           ON CONFLICT (route_id, place_id) DO NOTHING`,
  },
];

export interface ShapeResult {
  name: string;
  source: string;
  prepares: boolean;
  sqlstate: string | null;
  error: string | null;
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const client = await pool.connect().catch(() => null);
  if (!client) {
    return NextResponse.json({
      ok: true,
      probe: 'sql_shape_check_v1',
      checked: 0,
      broken: null,
      note: 'Соединение не получено — это отказ проверки, а не «все запросы целы».',
      duration_ms: Date.now() - startedAt,
    });
  }

  const results: ShapeResult[] = [];
  try {
    for (let i = 0; i < SHAPES.length; i++) {
      const s = SHAPES[i];
      const stmt = `shape_probe_${i}`;
      try {
        await client.query(`PREPARE ${stmt} AS ${s.sql}`);
        results.push({ name: s.name, source: s.source, prepares: true, sqlstate: null, error: null });
      } catch (err) {
        const e = err as { message?: string; code?: string };
        console.error(`[sql-shape-check] «${s.name}» не разбирается:`, e?.message, `SQLSTATE=${e?.code}`);
        results.push({
          name: s.name, source: s.source, prepares: false,
          sqlstate: e?.code ?? null, error: e?.message ?? 'неизвестная ошибка',
        });
      }
    }
  } finally {
    await client.query('DEALLOCATE ALL').catch((err) => {
      console.error('[sql-shape-check] очистка не удалась:', err instanceof Error ? err.message : err);
    });
    client.release();
  }

  const broken = results.filter((r) => !r.prepares);

  return NextResponse.json({
    ok: true,
    probe: 'sql_shape_check_v1',
    checked: results.length,
    broken_count: broken.length,
    broken,
    results,
    // Полноту реестра держит CI-правило (sql-param-cast-shape): запрос этой
    // формы, не внесённый сюда, не проходит сборку. Поэтому «не знаю» здесь
    // сузилось до одного: правило читает шаблонные строки, и SQL, собранный
    // конкатенацией во время работы, мимо него пройдёт.
    registry_completeness_guarded_by: 'tests/unit/sql-param-cast-shape.test.ts',
    registry_blind_to: 'SQL, собранный конкатенацией во время работы, а не записанный шаблонной строкой',
    proves: 'Разбирается ли запрос сервером: вывод типов параметров, имена колонок, синтаксис.',
    does_not_prove: 'Что запрос делает то, что задумано, и что таких мест в репозитории больше нет.',
    duration_ms: Date.now() - startedAt,
  });
}
