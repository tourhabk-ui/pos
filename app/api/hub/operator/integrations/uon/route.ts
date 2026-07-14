/**
 * Интеграция оператора с U-ON.Travel CRM.
 *
 * GET    — статус подключения (маскированный ключ, company_id). Полный ключ НЕ отдаём.
 * PUT    — сохранить/обновить uon_api_key + uon_company_id (оператор вводит свой ключ).
 * DELETE — отключить (очистить ключ).
 *
 * После сохранения ключа брони с Ведар автоматически создают заявку в U-ON оператора
 * (см. app/api/hub/bookings/create + lib/integrations/uon.ts). Ключ — секрет: хранится
 * в partners.uon_api_key, наружу отдаётся только маска.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

async function getPartnerId(userId: string): Promise<string | null> {
  const r = await query(`SELECT id FROM partners WHERE user_id = $1 LIMIT 1`, [userId]);
  return (r.rows[0]?.id as string) ?? null;
}

/** Маска ключа для UI: показываем только хвост, тело скрыто. */
function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 4) return '••••';
  return `••••${k.slice(-4)}`;
}

export async function GET(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const partnerId = await getPartnerId(auth.userId);
  if (!partnerId) return NextResponse.json({ error: 'Профиль не найден' }, { status: 404 });

  const r = await query<{ uon_api_key: string | null; uon_company_id: number | null }>(
    `SELECT uon_api_key, uon_company_id FROM partners WHERE id = $1`,
    [partnerId],
  );
  const row = r.rows[0];
  const key = row?.uon_api_key ?? null;

  return NextResponse.json({
    success: true,
    data: {
      connected: Boolean(key),
      keyMask: key ? maskKey(key) : null,
      companyId: row?.uon_company_id ?? null,
    },
  });
}

const PutSchema = z.object({
  // Ключ U-ON — непустая строка без пробелов. Пустую строку трактуем как «не менять».
  apiKey: z.string().trim().min(8, 'Ключ слишком короткий').max(200).optional().or(z.literal('')),
  companyId: z.number().int().positive().nullable().optional(),
});

export async function PUT(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const partnerId = await getPartnerId(auth.userId);
  if (!partnerId) return NextResponse.json({ error: 'Профиль не найден' }, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }, { status: 422 });
  }
  const { apiKey, companyId } = parsed.data;

  const params: unknown[] = [];
  const setClauses: string[] = ['updated_at = NOW()'];
  const add = (col: string, val: unknown) => { params.push(val); setClauses.push(`${col} = $${params.length}`); };

  // Пустой apiKey = не трогаем ключ (оператор редактирует только company_id).
  if (typeof apiKey === 'string' && apiKey !== '') add('uon_api_key', apiKey.trim());
  if (companyId !== undefined) add('uon_company_id', companyId);

  if (setClauses.length === 1) {
    return NextResponse.json({ error: 'Нечего сохранять' }, { status: 400 });
  }

  params.push(partnerId);
  await query(`UPDATE partners SET ${setClauses.join(', ')} WHERE id = $${params.length}`, params);

  return NextResponse.json({ success: true, message: 'Интеграция U-ON сохранена' });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const partnerId = await getPartnerId(auth.userId);
  if (!partnerId) return NextResponse.json({ error: 'Профиль не найден' }, { status: 404 });

  await query(
    `UPDATE partners SET uon_api_key = NULL, uon_company_id = NULL, updated_at = NOW() WHERE id = $1`,
    [partnerId],
  );
  return NextResponse.json({ success: true, message: 'Интеграция U-ON отключена' });
}
