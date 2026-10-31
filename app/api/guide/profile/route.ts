import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/lib/database';
import { UpdateGuideProfileSchema, writeGuideProfilePatch } from '@/lib/guides/profile-write';
import { ApiResponse } from '@/types';
import { getGuidePartnerByUserId, ensureGuidePartnerExists, getGuideStats, type GuideStats } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { GuideUserRow } from '@/lib/types/db-rows';
import { logGuideFailure, sqlState } from '@/lib/guides/db-failure';

/**
 * Профиль гида.
 *
 * «О себе» пишется в `partners.description` — это та колонка, которую
 * читает публичный профиль `/guides/[id]`. Прежний PUT писал в `bio`,
 * которой в схеме нет: сохранение падало 42703, но только ПОСЛЕ того, как
 * имя уже было записано в users, — частичная запись без транзакции.
 * Теперь users и partners пишутся одной транзакцией.
 *
 * `location` — jsonb `{lat, lng}` (PostGIS в базе нет).
 *
 * Администратор может смотреть экран, но запись гида для него НЕ создаётся:
 * прежде админ, открывший профиль гида, получал лишнюю строку partners.
 */
export const dynamic = 'force-dynamic';

/**
 * GET /api/guide/profile
 */
export async function GET(request: NextRequest) {
  const guideOrResponse = await requireRole(request, ['guide', 'admin']);
  if (guideOrResponse instanceof NextResponse) return guideOrResponse;
  const { userId, role } = guideOrResponse;

  try {
    const userResult = await query<GuideUserRow>(
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];
    if (!user) {
      return NextResponse.json({ success: false, error: 'Пользователь не найден' } as ApiResponse<null>, { status: 404 });
    }

    let partner = await getGuidePartnerByUserId(userId);
    if (!partner && role === 'guide') {
      await ensureGuidePartnerExists(userId);
      partner = await getGuidePartnerByUserId(userId);
    }

    // Статистика — отдельно: её отказ не должен ронять профиль, но и не
    // выдаётся за «нулевую статистику».
    let stats: GuideStats | null = null;
    let statsError: string | null = null;
    if (partner) {
      try {
        stats = await getGuideStats(userId);
      } catch {
        statsError = 'Статистику загрузить не удалось';
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at },
        partner,
        stats,
        statsError,
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('GET /api/guide/profile', error);
    return NextResponse.json({ success: false, error: 'Ошибка при получении профиля' } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * PUT /api/guide/profile
 */
export async function PUT(request: NextRequest) {
  const guideOrResponse = await requireRole(request, ['guide', 'admin']);
  if (guideOrResponse instanceof NextResponse) return guideOrResponse;
  const { userId, role } = guideOrResponse;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = UpdateGuideProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
  }
  const { submitForReview } = parsed.data;

  try {
    let partner = await getGuidePartnerByUserId(userId);
    if (!partner && role === 'guide') {
      await ensureGuidePartnerExists(userId);
      partner = await getGuidePartnerByUserId(userId);
    }
    if (!partner) {
      return NextResponse.json({
        success: false,
        error: 'Профиля гида у этого аккаунта нет — править нечего',
      } as ApiResponse<null>, { status: 403 });
    }
    const partnerId = partner.id;

    // Та же запись, что «Сохранить» в чате кабинета (lib/guides/profile-write).
    await transaction(async (client) => {
      await writeGuideProfilePatch(client, { partnerId, userId, patch: parsed.data });
    });

    const updatedPartner = await getGuidePartnerByUserId(userId);
    return NextResponse.json({
      success: true,
      data: { partner: updatedPartner },
      message: submitForReview ? 'Профиль отправлен на проверку' : 'Профиль сохранён',
    } as ApiResponse<unknown>);
  } catch (error: unknown) {
    logGuideFailure('PUT /api/guide/profile', error);
    if (sqlState(error) === '23514') {
      return NextResponse.json({
        success: false,
        error: 'Некорректные данные. Проверьте значения полей.',
      } as ApiResponse<null>, { status: 400 });
    }
    return NextResponse.json({ success: false, error: 'Ошибка при обновлении профиля' } as ApiResponse<null>, { status: 500 });
  }
}
