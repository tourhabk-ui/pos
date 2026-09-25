/**
 * GET  /api/hub/operator/profile — получить профиль оператора
 * PATCH /api/hub/operator/profile — обновить профиль
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { query } from '@/lib/database';
import { reachForPartner } from '@/lib/partners/reach';
import { isCleared, mergeClearable } from '@/lib/operator/profile-patch';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// Партнёр выбирается общим helper'ом: у одного user_id бывает несколько
// партнёрских записей (гид + оператор — обычный камчатский случай), и прежний
// `WHERE user_id = $1 LIMIT 1` без category и ORDER BY отдавал произвольную из
// них — оператор мог править профиль своей же гидовской записи.

/**
 * Статус уведомлений о бронях в Telegram — по РЕАЛЬНОМУ источнику.
 *
 * Уведомления читают `partners.telegram_chat_id` или `users.telegram_id`
 * (lib/partners/reach.ts), а поле «Telegram» профиля пишет
 * `contacts.telegram` — публичный контакт для клиентов, который бот не читает.
 * Поэтому статус считается reachFrom-правилом, а не по заполненности поля.
 * Не смогли прочитать — `unknown`, а не «не подключены» (§4.0).
 */
async function telegramNotifications(partnerId: string): Promise<{
  status: 'connected' | 'not_connected' | 'unknown';
  source: 'partner' | 'user' | null;
}> {
  const reach = await reachForPartner(partnerId);
  if (!reach) return { status: 'unknown', source: null };
  return {
    status: reach.telegramChatId ? 'connected' : 'not_connected',
    source: reach.telegramSource,
  };
}

export async function GET(request: NextRequest) {
  const authOrResponse = await requireOperator(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const partnerId = await getOperatorPartnerId(authOrResponse.userId);
  if (!partnerId) {
    return NextResponse.json(
      { success: false, error: 'Профиль оператора не найден' },
      { status: 404 },
    );
  }

  const r = await query(`
    SELECT
      p.id, p.name AS company_name, p.category, p.description, p.short_description,
      p.profile_status, p.onboarding_completed, p.is_public, p.is_verified,
      p.contacts, p.location, p.services, p.features,
      p.hero_image, p.logo_image,
      p.payout_method, p.payout_verified, p.commission_current,
      p.profile_review_comment,
      p.telegram_chat_id,
      u.email, u.name AS contact_name
    FROM partners p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = $1
  `, [partnerId]);

  const row = r.rows[0];
  if (!row) return NextResponse.json({ success: true, data: null });

  return NextResponse.json({
    success: true,
    data: { ...row, telegram_notifications: await telegramNotifications(partnerId) },
  });
}

/**
 * Текстовое поле профиля: строка — записать, '' или null — ОЧИСТИТЬ,
 * отсутствие — не трогать. До 25.09 клиент слал `x.trim() || undefined`,
 * и стёртое поле молча оставалось в базе: человек видел «Профиль сохранён»,
 * а старый телефон продолжал висеть в карточке.
 */
const clearable = (max: number) => z.string().trim().max(max).nullable().optional();

const PatchSchema = z.object({
  description:         clearable(2000),
  short_description:   clearable(300),
  website:             clearable(500),
  phone:               clearable(30),
  telegram:            clearable(100),
  services:            z.array(z.string().max(100)).max(20).optional(),
  features:            z.array(z.string().max(100)).max(20).optional(),
  location:            z.object({
    address: clearable(255),
    city:    clearable(100),
  }).optional(),
  complete_onboarding: z.boolean().optional(),
  telegram_chat_id:    z.number().int().nullable().optional(),
});

export async function PATCH(request: NextRequest) {
  const authOrResponse = await requireOperator(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const partnerId = await getOperatorPartnerId(authOrResponse.userId);
  if (!partnerId) {
    return NextResponse.json(
      { success: false, error: 'Профиль оператора не найден' },
      { status: 404 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' },
      { status: 422 }
    );
  }

  const {
    description, short_description,
    website, phone, telegram,
    services, features, location,
    complete_onboarding, telegram_chat_id,
  } = parsed.data;

  const existingRes = await query(
    `SELECT contacts, location FROM partners WHERE id = $1`, [partnerId]
  );
  const currentContacts = (existingRes.rows[0]?.contacts as Record<string, unknown> | null) ?? {};
  const currentLocation = (existingRes.rows[0]?.location as Record<string, unknown> | null) ?? {};
  const newContacts = mergeClearable(currentContacts, { phone, telegram, website });

  const params: unknown[] = [];
  const setClauses: string[] = ['updated_at = NOW()'];

  const p = (col: string, val: unknown) => {
    params.push(val);
    setClauses.push(`${col} = $${params.length}`);
  };

  if (description       !== undefined) p('description',       isCleared(description) ? null : description);
  if (short_description !== undefined) p('short_description', isCleared(short_description) ? null : short_description);
  if (services          !== undefined) p('services',          JSON.stringify(services));
  if (features          !== undefined) p('features',          JSON.stringify(features));
  if (location          !== undefined) {
    const nextLocation = mergeClearable(currentLocation, { city: location.city, address: location.address });
    p('location', Object.keys(nextLocation).length > 0 ? JSON.stringify(nextLocation) : null);
  }
  if (complete_onboarding) {
    p('onboarding_completed', true);
    // Завершённый онбординг — это поданная заявка. До 25.09 оператор после
    // регистрации оставался в 'none' навсегда: админка модерации по
    // умолчанию показывает status=pending и его не видела. Переводим ТОЛЬКО
    // из 'none': одобренного или отклонённого повторное завершение не
    // возвращает в очередь, и applied_at не переписывается.
    setClauses.push(`applied_at = CASE WHEN profile_status = 'none' THEN NOW() ELSE applied_at END`);
    setClauses.push(`profile_status = CASE WHEN profile_status = 'none' THEN 'pending' ELSE profile_status END`);
  }
  if (telegram_chat_id !== undefined)  p('telegram_chat_id', telegram_chat_id);
  p('contacts', JSON.stringify(newContacts));

  params.push(partnerId);
  await query(
    `UPDATE partners SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
    params
  );

  return NextResponse.json({ success: true, message: 'Профиль сохранён' });
}
