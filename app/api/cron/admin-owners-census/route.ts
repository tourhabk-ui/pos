/**
 * GET /api/cron/admin-owners-census — у кого есть роль администратора и чем
 * это записано. Bearer CRON_SECRET, только чтение.
 *
 * ЗАЧЕМ (23.10). До этого дня PUT /api/profile писал `preferences` целиком,
 * а `preferences.roles` пускает в /api/auth/switch-role: турист мог записать
 * себе `roles: ['admin']` и войти администратором. Дверь закрыта
 * (`lib/auth/server-owned-preferences`), но уже записанное она не снимает —
 * и пользовался ли ею кто-нибудь, по коду не узнать.
 *
 * Перепись называет факты, а не приговор:
 * - роль `admin` активна или лежит в собственных ролях;
 * - есть ли запись о выдаче ДРУГИМ человеком (audit_log `role_change`: с 23.10
 *   её пишет PATCH /api/admin/users/[id], раньше — только POST /api/roles,
 *   который не вызывался ниоткуда); выдача самому себе отдельно;
 * - был ли человек админом ДО первого переключения роли (первая запись
 *   `role_switch` — из admin). Так выглядит аккаунт, которому админа дали
 *   на сервере; турист, открывший дверь профиля, начинает с перехода в admin;
 * - когда впервые переключился в админа.
 * Аккаунт владельца, заведённый до журнала, записи о выдаче не имеет — поэтому
 * вердикта «подделка» здесь нет, его выносит человек. Отсутствие записи может
 * значить и сбой записи журнала: до 23.10 эти сбои глушились молча.
 * Ни почт, ни имён в ответе нет: только id, роль, даты и признаки.
 *
 * Прочие роли, которые та же дверь давала записать (оператор, агент…), здесь
 * не считаются: их и так даёт самостоятельная регистрация.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Row {
  id: string;
  active_role: string;
  created_at: string;
  admin_in_owned: boolean;
  granted_on_record: boolean;
  granted_by_self: boolean;
  admin_before_any_switch: boolean | null;
  first_switch_to_admin_at: string | null;
}

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { rows } = await pool.query<Row>(
      `SELECT u.id::text AS id, u.role AS active_role, u.created_at::text AS created_at,
              COALESCE(jsonb_typeof(u.preferences->'roles') = 'array'
                       AND (u.preferences->'roles') ? 'admin', FALSE) AS admin_in_owned,
              EXISTS (SELECT 1 FROM audit_log a
                       WHERE a.entity_type = 'user' AND a.entity_id = u.id
                         AND a.action = 'role_change' AND a.data->>'role' = 'admin'
                         AND a.data->>'changedBy' IS DISTINCT FROM u.id::text) AS granted_on_record,
              EXISTS (SELECT 1 FROM audit_log a
                       WHERE a.entity_type = 'user' AND a.entity_id = u.id
                         AND a.action = 'role_change' AND a.data->>'role' = 'admin'
                         AND a.data->>'changedBy' = u.id::text) AS granted_by_self,
              (SELECT a.data->>'from' = 'admin' FROM audit_log a
                WHERE a.entity_type = 'user' AND a.entity_id = u.id AND a.action = 'role_switch'
                ORDER BY a.created_at ASC, a.id ASC LIMIT 1) AS admin_before_any_switch,
              (SELECT MIN(a.created_at)::text FROM audit_log a
                WHERE a.entity_type = 'user' AND a.entity_id = u.id
                  AND a.action = 'role_switch' AND a.data->>'to' = 'admin') AS first_switch_to_admin_at
         FROM users u
        WHERE u.role = 'admin'
           OR (jsonb_typeof(u.preferences->'roles') = 'array' AND (u.preferences->'roles') ? 'admin')
        ORDER BY u.created_at ASC NULLS LAST, u.id ASC`,
    );
    return NextResponse.json({
      ok: true,
      owners_total: rows.length,
      without_grant_on_record: rows.filter((r) => !r.granted_on_record).length,
      note: 'Вердикта нет. Нет записи о выдаче — значит её нет в журнале: аккаунт заведён до журнала, '
        + 'запись не удалась (до 23.10 такие сбои глушились) или роль записана через дверь профиля, закрытую 23.10.',
      owners: rows,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[admin-owners-census] перепись не прочитана, SQLSTATE', code);
    return NextResponse.json({ ok: false, error: 'Перепись не прочитана', sqlstate: code }, { status: 500 });
  }
}
