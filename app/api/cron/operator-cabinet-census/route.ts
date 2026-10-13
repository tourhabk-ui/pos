/**
 * GET /api/cron/operator-cabinet-census — один ли кабинет находят у оператора
 * календарь и общий резолвер. ТОЛЬКО ЧТЕНИЕ.
 *
 * Повод — CRM 2г-2 (команда оператора). Календарь (5 роутов) ищет кабинет
 * старым запросом «первый попавшийся профиль человека» — без категории и
 * без порядка. Общий резолвер (operatorAccess) берёт самый ранний
 * профиль с category = 'operator'. Пока это разные запросы, менеджер команды
 * календаря не видит; перевести календарь на резолвер вслепую нельзя:
 * если у живого оператора туры висят на профиле другой категории (или без
 * категории), он потеряет свой календарь. Это замороженный долг сторожа
 * crm-partner-context (KNOWN_WITHOUT_CATEGORY), и решает его число, а не
 * догадка.
 *
 * Отвечает:
 *   - сколько людей с ролью оператора, у скольких есть профиль оператора;
 *   - у кого туры или даты календаря висят на профиле НЕ оператора — это и
 *     есть те, кого перевод календаря задел бы (`at_risk`);
 *   - у кого профилей оператора больше одного (резолвер берёт самый ранний,
 *     старый запрос — любой);
 *   - чьи туры по категориям владельца-партнёра.
 *
 * Персональных данных в ответе нет: ответ уходит в лог прогона на раннере.
 * Только счёт и id (uuid) — по ним человека находят в базе, а почту и имя
 * из лога не прочитать.
 *
 * Чего перепись не знает: оператора, который календарём ни разу не
 * пользовался и туров не завёл, она считает, но риска у него нет — перевод
 * ему ничего не меняет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Люди с ролью оператора: текущая роль или роль в preferences.roles. */
const OP_USERS_CTE = `
  WITH op_users AS (
    SELECT u.id
      FROM users u
     WHERE u.role = 'operator'
        OR (JSONB_TYPEOF(u.preferences->'roles') = 'array' AND u.preferences->'roles' ? 'operator')
  ),
  parts AS (
    SELECT p.id, p.user_id, p.category, p.created_at,
           (SELECT COUNT(*) FROM operator_tours t
             WHERE t.operator_id = p.id AND t.deleted_at IS NULL)::int AS tours,
           (SELECT COUNT(*) FROM tour_availability a
              JOIN operator_tours t ON t.id = a.operator_tour_id
             WHERE t.operator_id = p.id AND t.deleted_at IS NULL)::int AS slots
      FROM partners p
     WHERE p.user_id IN (SELECT id FROM op_users)
  ),
  per_user AS (
    SELECT u.id AS user_id,
           COUNT(pa.id)::int                                                    AS partner_rows,
           COUNT(pa.id) FILTER (WHERE pa.category = 'operator')::int            AS operator_rows,
           COALESCE(SUM(pa.tours) FILTER (WHERE pa.category IS DISTINCT FROM 'operator'), 0)::int AS foreign_tours,
           COALESCE(SUM(pa.slots) FILTER (WHERE pa.category IS DISTINCT FROM 'operator'), 0)::int AS foreign_slots
      FROM op_users u
      LEFT JOIN parts pa ON pa.user_id = u.id
     GROUP BY u.id
  )`;

interface Totals {
  operator_users: number;
  with_operator_profile: number;
  without_any_profile: number;
  only_other_categories: number;
  several_operator_profiles: number;
  several_profiles_any: number;
  at_risk_users: number;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const startedAt = Date.now();

  try {
    const [totals, byCategory, atRisk, toursByOwner] = await Promise.all([
      pool.query<Totals>(
        `${OP_USERS_CTE}
         SELECT COUNT(*)::int                                                         AS operator_users,
                COUNT(*) FILTER (WHERE operator_rows > 0)::int                        AS with_operator_profile,
                COUNT(*) FILTER (WHERE partner_rows = 0)::int                         AS without_any_profile,
                COUNT(*) FILTER (WHERE partner_rows > 0 AND operator_rows = 0)::int   AS only_other_categories,
                COUNT(*) FILTER (WHERE operator_rows > 1)::int                        AS several_operator_profiles,
                COUNT(*) FILTER (WHERE partner_rows > 1)::int                         AS several_profiles_any,
                COUNT(*) FILTER (WHERE foreign_tours > 0 OR foreign_slots > 0)::int   AS at_risk_users
           FROM per_user`,
      ),
      // Профили людей с ролью оператора по категориям: сколько, с турами, с датами.
      pool.query<{ category: string; profiles: number; with_tours: number; tours: number; slots: number }>(
        `${OP_USERS_CTE}
         SELECT COALESCE(category, '(пусто)') AS category,
                COUNT(*)::int AS profiles,
                COUNT(*) FILTER (WHERE tours > 0)::int AS with_tours,
                COALESCE(SUM(tours), 0)::int AS tours,
                COALESCE(SUM(slots), 0)::int AS slots
           FROM parts
          GROUP BY 1
          ORDER BY profiles DESC`,
      ),
      // Кого перевод календаря задел бы: туры или даты на профиле не оператора.
      pool.query<{ user_id: string; partner_rows: number; operator_rows: number; foreign_tours: number; foreign_slots: number }>(
        `${OP_USERS_CTE}
         SELECT user_id::text, partner_rows, operator_rows, foreign_tours, foreign_slots
           FROM per_user
          WHERE foreign_tours > 0 OR foreign_slots > 0
          ORDER BY foreign_tours DESC, foreign_slots DESC
          LIMIT 50`,
      ),
      // Все живые туры по категории владельца-партнёра, в том числе туры
      // партнёров без аккаунта (импорт): календарём они не пользуются.
      pool.query<{ category: string; owner_has_account: boolean; partners: number; tours: number }>(
        `SELECT COALESCE(p.category, '(пусто)') AS category,
                (p.user_id IS NOT NULL) AS owner_has_account,
                COUNT(DISTINCT p.id)::int AS partners,
                COUNT(*)::int AS tours
           FROM operator_tours t
           JOIN partners p ON p.id = t.operator_id
          WHERE t.deleted_at IS NULL
          GROUP BY 1, 2
          ORDER BY tours DESC`,
      ),
    ]);

    const t = totals.rows[0];
    const safe = t !== undefined && t.at_risk_users === 0;
    return NextResponse.json({
      ok: true,
      probe: 'operator_cabinet_census_v1',
      totals: t ?? null,
      profiles_by_category: byCategory.rows,
      at_risk: atRisk.rows,
      at_risk_truncated: atRisk.rows.length === 50,
      tours_by_owner_category: toursByOwner.rows,
      calendar_switch_safe: safe,
      reads_as: t === undefined
        ? 'перепись не вернула итогов — вывода нет'
        : safe
          ? 'туров и дат на профилях не оператора у людей с ролью оператора нет: календарь переводится на общий резолвер без потерь'
          : `у ${t.at_risk_users} операторов туры или даты висят на профиле не оператора — перевод календаря задел бы их; сначала разобрать данные`,
      pii_note: 'почта и имя не отдаются: ответ уходит в лог прогона (152-ФЗ)',
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
    console.error('[operator-cabinet-census] перепись не выполнена, SQLSTATE', code);
    return NextResponse.json({ ok: false, error: 'перепись не выполнена', sqlstate: code }, { status: 503 });
  }
}
