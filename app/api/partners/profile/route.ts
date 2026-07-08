/**
 * GET  /api/partners/profile — партнёрский профиль текущего пользователя
 *      (по роли из JWT; отсутствующий профиль создаётся автоматически
 *      через ensurePartnerForRole — закрывает legacy-аккаунты stay,
 *      которым раньше «профиль заводил администратор»)
 * PATCH /api/partners/profile — правка своего профиля + завершение
 *      онбординга (onboarding_completed)
 *
 * Общий эндпоинт для партнёрских ролей БЕЗ своего профильного API
 * (gear/stay/...). У оператора собственный /api/hub/operator/profile
 * с полем contacts — здесь пишется колонка contact (jsonb), которую
 * сидит ensurePartnerForRole и читают кабинеты gear/stay. Двухколоночное
 * legacy (contact/contacts) сознательно не трогаем в этом PR.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const PARTNER_ROLE_SET = new Set<string>(PARTNER_ROLES);

const PatchSchema = z.object({
  name:                z.string().min(1).max(255).optional(),
  description:         z.string().max(2000).optional(),
  short_description:   z.string().max(300).optional(),
  phone:               z.string().max(30).optional(),
  telegram:            z.string().max(100).optional(),
  website:             z.string().max(500).optional().or(z.literal('')),
  complete_onboarding: z.boolean().optional(),
});

async function resolvePartner(userId: string, role: string) {
  const r = await query(
    `SELECT id, name, category, description, short_description, contact,
            profile_status, onboarding_completed, is_verified
     FROM partners
     WHERE user_id = $1 AND category = $2
     LIMIT 1`,
    [userId, role]
  );
  return r.rows[0] ?? null;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const role = authResult.role ?? '';
  if (!PARTNER_ROLE_SET.has(role)) {
    return NextResponse.json(
      { success: false, error: 'Партнёрский профиль доступен только партнёрским ролям' },
      { status: 403 }
    );
  }

  try {
    let partner = await resolvePartner(authResult.userId, role);
    if (!partner) {
      await ensurePartnerForRole(authResult.userId, role);
      partner = await resolvePartner(authResult.userId, role);
    }
    if (!partner) {
      return NextResponse.json({ success: false, error: 'Профиль не найден' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: { partner } });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при получении профиля' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const role = authResult.role ?? '';
  if (!PARTNER_ROLE_SET.has(role)) {
    return NextResponse.json(
      { success: false, error: 'Партнёрский профиль доступен только партнёрским ролям' },
      { status: 403 }
    );
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { name, description, short_description, phone, telegram, website, complete_onboarding } = parsed.data;

  try {
    let partner = await resolvePartner(authResult.userId, role);
    if (!partner) {
      await ensurePartnerForRole(authResult.userId, role);
      partner = await resolvePartner(authResult.userId, role);
    }
    if (!partner) {
      return NextResponse.json({ success: false, error: 'Профиль не найден' }, { status: 404 });
    }

    // Merge contact (jsonb): непереданные ключи сохраняются
    const currentContact = (partner.contact as Record<string, string> | null) ?? {};
    const newContact = { ...currentContact };
    if (phone !== undefined) newContact.phone = phone;
    if (telegram !== undefined) newContact.telegram = telegram;
    if (website !== undefined) newContact.website = website;

    const params: unknown[] = [];
    const sets: string[] = ['updated_at = NOW()'];
    const set = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (name !== undefined) set('name', name);
    if (description !== undefined) set('description', description);
    if (short_description !== undefined) set('short_description', short_description);
    if (phone !== undefined || telegram !== undefined || website !== undefined) {
      set('contact', JSON.stringify(newContact));
    }
    if (complete_onboarding) set('onboarding_completed', true);

    params.push(partner.id);
    await query(
      `UPDATE partners SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );

    return NextResponse.json({ success: true, message: 'Профиль сохранён' });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при сохранении профиля' }, { status: 500 });
  }
}
