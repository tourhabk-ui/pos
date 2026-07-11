/**
 * GET /api/routes
 * Публичный каталог маршрутов из agent_route_knowledge.
 * Поддерживает: поиск, фильтрацию по категории, пагинацию, geo-фильтр.
 *
 * Query-логика вынесена в lib/routes/catalog-query.ts — общий data-слой с
 * SSR-рендером app/routes/page.tsx (шаг 3 аудита 11.07), чтобы листинг и API
 * не разъехались. Здесь остаётся только HTTP-обёртка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const parsed = CatalogQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры запроса' }, { status: 400 });
  }

  try {
    const { items, meta } = await queryCatalog(parsed.data);
    const response = NextResponse.json({ success: true, data: items, meta });
    response.headers.set('Cache-Control', 'private, no-cache');
    return response;
  } catch (error) {
    console.error('[/api/routes] DB error:', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка базы данных. Проверьте DATABASE_URL в env.' },
      { status: 503 }
    );
  }
}
