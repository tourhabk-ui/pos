/**
 * GET /api/discovery/search - Расширенный поиск туров
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { searchService } from '@/lib/services';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import {
  badQueryParam, nonNegativeAmount, queryInput, queryText, wholeNumber,
} from '@/lib/api/public-query';

/** Что видит аноним при отказе — словами, без текста исключения. */
const SEARCH_FAILED_TEXT = 'Поиск временно не работает, попробуйте позже';

/** Дальше этой страницы не листают: 10 000 × 100 — миллион строк сдвига. */
const MAX_PAGE = 10_000;
const MAX_LIMIT = 100;

/**
 * Вход поиска — проверяется ДО базы (ревью #2642, третий круг). Прежде
 * `?page=0` давал `OFFSET -20`, `?limit=-1` — отрицательный LIMIT, а
 * `?page=abc` в ветке AI-тегов — `NaN` в bigint: база отказывала, и человек
 * читал «временно не работает», хотя повтор ничего не изменит. Текст — без
 * символа NUL: его PostgreSQL не принимает (22021).
 */
const SearchQuery = z.object({
  q: queryText.optional(),
  page: wholeNumber(1, MAX_PAGE).default(1),
  limit: wholeNumber(1, MAX_LIMIT).default(20),
  activity: queryText.optional(),
  difficulty: queryText.optional(),
  minPrice: nonNegativeAmount.optional(),
  maxPrice: nonNegativeAmount.optional(),
  rating: nonNegativeAmount.optional(),
  sortBy: queryText.optional(),
  landscape: queryText.optional(),
  feature: queryText.optional(),
});
type SearchParam = keyof z.input<typeof SearchQuery>;

/** Что не так с параметром — его именем и словами, как правильно. */
const PARAM_TEXT: Record<SearchParam, string> = {
  q: 'Текст поиска (q) содержит недопустимый символ',
  page: `Номер страницы (page) — целое число от 1 до ${MAX_PAGE}`,
  limit: `Размер страницы (limit) — целое число от 1 до ${MAX_LIMIT}`,
  activity: 'Вид активности (activity) содержит недопустимый символ',
  difficulty: 'Сложность (difficulty) содержит недопустимый символ',
  minPrice: 'Цена от (minPrice) — число не меньше 0, например 15000',
  maxPrice: 'Цена до (maxPrice) — число не меньше 0, например 50000',
  rating: 'Рейтинг от (rating) — число не меньше 0, например 4.5',
  sortBy: 'Порядок (sortBy) содержит недопустимый символ',
  landscape: 'Ландшафт (landscape) содержит недопустимый символ',
  feature: 'Особенность (feature) содержит недопустимый символ',
};
const PARAM_KEYS = Object.keys(PARAM_TEXT) as SearchParam[];

// Public: поиск туров доступен без аутентификации.
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const parsed = SearchQuery.safeParse(queryInput(searchParams, PARAM_KEYS));
  if (!parsed.success) {
    // Неверный вход — не отказ базы: 400 с именем параметра, база не
    // спрашивалась, в лог отказов нечего писать.
    const bad = badQueryParam(parsed.error, PARAM_TEXT);
    return NextResponse.json(
      { success: false, error: bad?.error ?? 'Неверные параметры поиска', param: bad?.param ?? null },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Имя проверки для лога: какая из трёх веток поиска не выполнилась.
  let check = 'поиск по словам';
  try {
    const query = input.q ?? '';
    const { page, limit } = input;
    const offset = (page - 1) * limit;

    // Параметры фильтрации
    const activity = input.activity ?? null;
    const difficulty = input.difficulty ?? null;
    const { minPrice, maxPrice, rating } = input;
    // Порядок по умолчанию — правило 1в (слово владельца 29.10), не рейтинг.
    const sortBy = input.sortBy ?? 'order';

    // AI-теги фильтры (из ai_tags JSONB колонки)
    const tagLandscape = input.landscape;
    const tagActivity = input.activity;
    const tagFeature = input.feature;

    // Если заданы AI-теги — выполняем фильтрацию по ai_tags сразу.
    // Отбор — шлюзом витрины (#2642): ветка смотрела только is_active и
    // deleted_at, и черновик оператора (is_published = false), про который
    // кабинет говорит «туристы не видят», находился поиском по тегам.
    if (tagLandscape || tagActivity || tagFeature) {
      check = 'поиск по AI-тегам';
      const conditions: string[] = [publicTourSql('ot')];
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
      }

      const { query: dbQuery } = await import('@/lib/database');
      const tagResult = await dbQuery<{
        id: string; title: string; description: string; price: number;
        category: string; difficulty: string; ai_tags: Record<string, unknown>;
        nearest_free_date: string | null;
      }>(
        `SELECT ot.id, title, description, base_price AS price, activity_type AS category, difficulty, ai_tags,
                ${nearestFreeDateSql('ot')} AS nearest_free_date
         FROM operator_tours ot
         WHERE ${conditions.join(' AND ')}`,
        sqlParams
      );
      // Порядок — правило 1в, а не рейтинг (до 29.10 — `rating DESC`);
      // страница режется после порядка.
      const tagOrdered = orderOffersBy(tagResult.rows, (r) => ({ id: String(r.id), nearestFreeDate: r.nearest_free_date ?? null }));
      const tagPage = tagOrdered.slice(offset, offset + limit).map((r) => ({
        id: r.id, title: r.title, description: r.description, price: r.price,
        category: r.category, difficulty: r.difficulty, ai_tags: r.ai_tags,
      }));

      return NextResponse.json({
        success: true,
        data: tagPage,
        pagination: { page, limit, total: tagOrdered.length, hasMore: offset + limit < tagOrdered.length },
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
