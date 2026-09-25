import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGuidePartnerByUserId, ensureGuidePartnerExists, getGuideStats, type GuideStats } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { GuideUserRow } from '@/lib/types/db-rows';
import { logGuideFailure, sqlState } from '@/lib/guides/db-failure';
import { z } from 'zod';

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
const UpdateGuideProfileSchema = z.object({
  name: z.string().trim().min(1, 'Имя не может быть пустым').max(255).optional(),
  partnerName: z.string().trim().min(1, 'Название не может быть пустым').max(255).optional(),
  description: z.string().max(5000, 'Текст «О себе» — не длиннее 5000 символов').optional(),
  /** Телефон: пустая строка — явная очистка (ключ удаляется из contact). */
  phone: z.string().trim().max(30, 'Телефон — не длиннее 30 символов').optional(),
  experienceYears: z.number().int().min(0, 'Опыт работы — от 0 до 60 лет').max(60, 'Опыт работы — от 0 до 60 лет').nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  specializations: z.array(z.enum(['volcanoes', 'wildlife', 'fishing', 'history', 'photography', 'extreme', 'hiking', 'cultural', 'rafting', 'skiing'])).optional(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  isAvailable: z.boolean().optional(),
  /** Отправить профиль на проверку платформы (none/rejected → pending). */
  submitForReview: z.boolean().optional(),
});

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
  const {
    name, partnerName, description, phone, experienceYears,
    languages, specializations, location, isAvailable, submitForReview,
  } = parsed.data;

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

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (sql: (idx: number) => string, value: unknown) => {
      values.push(value);
      sets.push(sql(values.length));
    };

    if (partnerName !== undefined) set((i) => `name = $${i}`, partnerName);
    if (description !== undefined) set((i) => `description = $${i}`, description);
    if (phone !== undefined) {
      // Пустая строка — очистка: ключ удаляется, а не остаётся старый номер.
      if (phone === '') sets.push(`contact = COALESCE(contact, '{}'::jsonb) - 'phone'`);
      else set((i) => `contact = COALESCE(contact, '{}'::jsonb) || jsonb_build_object('phone', $${i}::text)`, phone);
    }
    if (experienceYears !== undefined) set((i) => `experience_years = $${i}`, experienceYears);
    if (languages !== undefined) set((i) => `languages = $${i}::text[]`, languages);
    if (specializations !== undefined) set((i) => `specializations = $${i}::text[]`, specializations);
    if (location !== undefined) set((i) => `location = $${i}::jsonb`, location === null ? null : JSON.stringify(location));
    if (isAvailable !== undefined) set((i) => `is_available = $${i}`, isAvailable);
    if (submitForReview) {
      // Заявка подаётся только из «не подана» или «отклонена»; одобренного
      // гида повторная отправка не откатывает на проверку.
      sets.push(`applied_at = CASE WHEN profile_status IN ('none', 'rejected') THEN NOW() ELSE applied_at END`);
      sets.push(`profile_status = CASE WHEN profile_status IN ('none', 'rejected') THEN 'pending' ELSE profile_status END`);
    }

    await transaction(async (client) => {
      if (name !== undefined) {
        await client.query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [name, userId]);
      }
      if (sets.length > 0) {
        values.push(partnerId);
        await client.query(
          `UPDATE partners SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
          values
        );
      }
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
