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
 * Перепись называет факты, а не приговор: роль `admin` активна или лежит в
 * собственных ролях, есть ли запись о выдаче администратором (POST /api/roles,
 * audit_log `role_change`), когда человек впервые переключился в админа.
 * Аккаунт владельца, заведённый не через POST /api/roles, записи о выдаче не
 * имеет тоже — поэтому вердикта «подделка» здесь нет, его выносит человек.
 * Ни почт, ни имён в ответе нет: только id, роль и даты.
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
                         AND a.action = 'role_change' AND a.data->>'role' = 'admin') AS granted_on_record,
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
      owners: rows,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[admin-owners-census] перепись не прочитана, SQLSTATE', code);
    return NextResponse.json({ ok: false, error: 'Перепись не прочитана', sqlstate: code }, { status: 500 });
  }
}
