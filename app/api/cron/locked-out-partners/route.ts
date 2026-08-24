/**
 * GET /api/cron/locked-out-partners?secret=<CRON_SECRET>
 *
 * Кого мы потеряли на запертой двери регистрации. Только чтение.
 *
 * ЗАЧЕМ. 24.08 выяснилось, что INSERT партнёрского профиля отвечал 42P08 и
 * не выполнялся никогда (CLAUDE.md §4.0, случай 24.08). Транзакции в
 * регистрации не было, поэтому строка в `users` фиксировалась автокоммитом,
 * а профиля не появлялось. Человек получал 500, на повторе — 409, и уйти из
 * этого состояния не мог. Пара следов «аккаунт есть, профиля нет» лежит в
 * базе до сих пор, и по ней потеря считается ТОЧНО, а не оценивается.
 *
 * ПОЧЕМУ ОПЕРАТОР — КОНТРОЛЬНАЯ ГРУППА, А НЕ ИСКЛЮЧЕНИЕ ИЗ СЧЁТА. У роли
 * `operator` в регистрации отдельная ветка с `VALUES`, её 42P08 не касался.
 * Значит если у операторов профили есть, а у остальных ролей нет — это
 * отпечаток именно этого дефекта, а не общей неисправности регистрации.
 * Убрать оператора из ответа значило бы выбросить единственную улику,
 * отличающую «сломан этот запрос» от «сломана регистрация вообще».
 *
 * ПЕРСОНАЛЬНЫХ ДАННЫХ В ОТВЕТЕ НЕТ. Ответ уходит в лог прогона на раннере,
 * а почта и имя — персональные данные (152-ФЗ). Отдаются только id, дата
 * и роль: этого хватает, чтобы найти человека в базе и написать ему, и не
 * хватает, чтобы прочитать его почту из лога.
 *
 * ЧЕГО ПЕРЕПИСЬ НЕ ЗНАЕТ. Тех, кто до конца регистрации не дошёл вовсе —
 * увидел 500, закрыл вкладку и не вернулся. Их аккаунт не создан, следа
 * нет. Эта потеря реальна и неизмерима, и она названа полем
 * `invisible_loss`, а не молча опущена.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Те же роли, что считает партнёрскими сама регистрация. */
export const PARTNER_ROLES = ['operator', 'guide', 'transfer', 'agent', 'stay', 'gear'] as const;

/** Ветка с VALUES — её дефект не касался. Служит контролем, не исключением. */
export const CONTROL_ROLE = 'operator';

export interface RoleRow {
  role: string;
  users_with_role: number;
  with_profile: number;
  without_profile: number;
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  // Роли человека: массив в preferences->roles, иначе одна users.role.
  // Разворачиваем в пары (пользователь, роль) — профиль заводится на пару.
  const ROLES_CTE = `
    WITH user_roles AS (
      SELECT u.id, u.created_at,
             CASE WHEN JSONB_TYPEOF(u.preferences->'roles') = 'array'
                  THEN ARRAY(SELECT JSONB_ARRAY_ELEMENTS_TEXT(u.preferences->'roles'))
                  ELSE ARRAY[u.role]
             END AS roles
        FROM users u
    ),
    pairs AS (
      SELECT ur.id, ur.created_at, r AS role
        FROM user_roles ur, UNNEST(ur.roles) AS r
       WHERE r = ANY($1::text[])
    )`;

  try {
    const [byRole, lost] = await Promise.all([
      pool.query<RoleRow>(
        `${ROLES_CTE}
         SELECT p.role,
                COUNT(*)::int                                  AS users_with_role,
                COUNT(pt.id)::int                              AS with_profile,
                (COUNT(*) - COUNT(pt.id))::int                 AS without_profile
           FROM pairs p
           LEFT JOIN partners pt ON pt.user_id = p.id AND pt.category = p.role
          GROUP BY p.role
          ORDER BY without_profile DESC, p.role`,
        [PARTNER_ROLES as unknown as string[]],
      ),
      // Поимённо — но без ПД: id, дата, роль. Почты и имени здесь нет.
      pool.query<{ id: string; role: string; created_at: string }>(
        `${ROLES_CTE}
         SELECT p.id::text, p.role, p.created_at::text
           FROM pairs p
           LEFT JOIN partners pt ON pt.user_id = p.id AND pt.category = p.role
          WHERE pt.id IS NULL
          ORDER BY p.created_at DESC
          LIMIT 200`,
        [PARTNER_ROLES as unknown as string[]],
      ),
    ]);

    const rows = byRole.rows;
    const control = rows.find((r) => r.role === CONTROL_ROLE) ?? null;
    const affected = rows.filter((r) => r.role !== CONTROL_ROLE);
    const lostTotal = affected.reduce((s, r) => s + r.without_profile, 0);

    const dates = lost.rows.map((r) => r.created_at).sort();

    return NextResponse.json({
      ok: true,
      probe: 'locked_out_partners_v1',

      // Главная цифра: партнёрские роли без профиля, кроме контрольной.
      lost_total: lostTotal,
      by_role: rows,

      // Контроль. Ноль без профиля у оператора при ненулевых у остальных —
      // отпечаток ИМЕННО сломанного запроса, а не общей поломки регистрации.
      control_role: CONTROL_ROLE,
      control: control,
      control_reads_as: control === null
        ? 'операторов в базе нет — контроля нет, вывод о причине не делается'
        : control.without_profile === 0
          ? 'у контрольной роли профили на месте: похоже именно на дефект сломанной ветки'
          : 'у контрольной роли тоже есть пропуски: причина шире одного запроса, разбирать отдельно',

      first_lost_at: dates[0] ?? null,
      last_lost_at:  dates[dates.length - 1] ?? null,
      lost_rows: lost.rows,
      lost_rows_truncated: lost.rows.length === 200,

      pii_note: 'почта и имя не отдаются: ответ уходит в лог прогона (152-ФЗ)',
      invisible_loss:
        'Кто увидел 500 и не вернулся, аккаунта не создал — следа нет. ' +
        'Эта потеря реальна и этой переписью не измеряется.',

      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[locked-out-partners] перепись не удалась:', e?.message, `SQLSTATE=${e?.code}`);
    // Отказ переписи — это отказ, а не «потерь нет».
    return NextResponse.json(
      { ok: false, probe: 'locked_out_partners_v1', error: e?.message ?? 'ошибка', sqlstate: e?.code ?? null },
      { status: 500 },
    );
  }
}
