/**
 * GET /api/discovery/search - Расширенный поиск туров
 */

import { NextRequest, NextResponse } from 'next/server';
import { searchService } from '@/lib/services';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

/** Что видит аноним при отказе — словами, без текста исключения. */
const SEARCH_FAILED_TEXT = 'Поиск временно не работает, попробуйте позже';

// Public: поиск туров доступен без аутентификации.
export async function GET(request: NextRequest) {
  // Имя проверки для лога: какая из трёх веток поиска не выполнилась.
  let check = 'поиск по словам';
  try {
    // Получить параметры из query
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const page = parseInt(searchParams.get('page') || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
    const offset = (page - 1) * limit;

    // Параметры фильтрации
    const activity = searchParams.get('activity');
    const difficulty = searchParams.get('difficulty');
    const minPrice = searchParams.get('minPrice')
      ? parseInt(searchParams.get('minPrice')!)
      : undefined;
    const maxPrice = searchParams.get('maxPrice')
      ? parseInt(searchParams.get('maxPrice')!)
      : undefined;
    const rating = searchParams.get('rating')
      ? parseFloat(searchParams.get('rating')!)
      : undefined;
    const sortBy = searchParams.get('sortBy') || 'rating';

    // AI-теги фильтры (из ai_tags JSONB колонки)
    const tagLandscape = searchParams.get('landscape');
    const tagActivity = searchParams.get('activity');
    const tagFeature = searchParams.get('feature');

    // Если заданы AI-теги — выполняем фильтрацию по ai_tags сразу.
    // Отбор — шлюзом витрины (#2642): ветка смотрела только is_active и
    // deleted_at, и черновик оператора (is_published = false), про который
    // кабинет говорит «туристы не видят», находился поиском по тегам.
    if (tagLandscape || tagActivity || tagFeature) {
      check = 'поиск по AI-тегам';
      const conditions: string[] = [publicTourSql('')];
      const sqlParams: (string | number)[] = [];
      let pIdx = 1;

      if (tagLandscape) {
        conditions.push(`ai_tags->'landscape' ? $${pIdx}`);
        sqlParams.push(tagLandscape);
        pIdx++;
      }
      if (tagActivity) {
        conditions.push(`ai_tags->'activity' ? $${pIdx}`);
        sqlParams.push(tagActivity);
        pIdx++;
      }
      if (tagFeature) {
        conditions.push(`ai_tags->'features' ? $${pIdx}`);
        sqlParams.push(tagFeature);
        pIdx++;
      }

      sqlParams.push(limit, offset);

      const { query: dbQuery } = await import('@/lib/database');
      const tagResult = await dbQuery<{
        id: string; title: string; description: string; price: number;
        category: string; difficulty: string; ai_tags: Record<string, unknown>;
      }>(
        `SELECT id, title, description, base_price AS price, activity_type AS category, difficulty, ai_tags
         FROM operator_tours
         WHERE ${conditions.join(' AND ')}
         ORDER BY rating DESC NULLS LAST
         LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
        sqlParams
      );

      return NextResponse.json({
        success: true,
        data: tagResult.rows,
        pagination: { page, limit, total: tagResult.rows.length, hasMore: false },
        meta: { filteredByAiTags: true },
      }, { status: 200 });
    }

    // Если есть параметр advanced=true, использовать продвинутый поиск с фасетами
    const isAdvanced = searchParams.get('advanced') === 'true';

    if (isAdvanced) {
      check = 'расширенный поиск';
      // Продвинутый поиск с фасетами
      const result = await searchService.advancedSearch({
        query,
        filters: {
          activity,
          difficulty,
          minPrice,
          maxPrice,
          rating,
        },
        sortBy,
        limit,
        offset,
      });

      return NextResponse.json(
        {
          success: true,
          data: result.tours,
          facets: result.facets,
          pagination: {
            page,
            limit,
            total: result.total,
            totalPages: Math.ceil(result.total / limit),
            hasMore: result.hasMore,
          },
          executionTime: result.executionTime,
        },
        { status: 200 }
      );
    }

    // Базовый поиск
    const result = await searchService.search({
      query,
      filters: {
        activity,
        difficulty,
        minPrice,
        maxPrice,
        rating,
      },
      sortBy,
      limit,
      offset,
    });

    return NextResponse.json(
      {
        success: true,
        data: result.tours,
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
          hasMore: result.hasMore,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    // Текст исключения анониму не отдаётся: у PostgreSQL он называет таблицы,
    // колонки и statement timeout. В лог — имя проверки и SQLSTATE (§4.0);
    // параметры запроса (слова поиска) туда не идут.
    logSwallowedFailure('discovery-search', check, error);
    return NextResponse.json(
      { success: false, error: SEARCH_FAILED_TEXT },
      { status: 500 }
    );
  }
}
