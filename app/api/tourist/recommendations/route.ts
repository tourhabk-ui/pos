/**
 * GET /api/tourist/recommendations
 * Персонализированные рекомендации туров (только для туристов)
 * Кэш 24 часа в PostgreSQL
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getRecommendations,
  getCachedRecommendations,
  saveRecommendationsCache,
} from '@/lib/recommendations/engine';
import { requireRole } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const ALLOWED_CATEGORIES = ['trekking', 'bears', 'thermal', 'boat_trip', 'helicopter'] as const;

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireRole(request, ['tourist', 'admin']);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get('limit') ?? '6', 10),
      12
    );

    const forceRefresh = request.nextUrl.searchParams.get('refresh') === '1';

    const rawCategory = request.nextUrl.searchParams.get('category');
    const category = rawCategory && (ALLOWED_CATEGORIES as readonly string[]).includes(rawCategory)
      ? rawCategory
      : undefined;

    // Кэш (24ч) — общий, единственный слот на юзера (без учёта category).
    // Фильтрованный по режиму похода запрос всегда обходит и не перезаписывает
    // общий кэш, иначе выбор режима "затирал" бы обычные рекомендации.
    if (!forceRefresh && !category) {
      const cached = await getCachedRecommendations(userId);
      if (cached) {
        return NextResponse.json({
          success: true,
          data: cached.slice(0, limit),
          meta: { cached: true, count: cached.slice(0, limit).length },
        });
      }
    }

    // Генерируем свежие рекомендации
    const recommendations = await getRecommendations(userId, limit, category);

    if (!category) {
      await saveRecommendationsCache(userId, recommendations);
    }

    return NextResponse.json({
      success: true,
      data: recommendations,
      meta: { cached: false, count: recommendations.length, category: category ?? null },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка получения рекомендаций' },
      { status: 500 }
    );
  }
}
