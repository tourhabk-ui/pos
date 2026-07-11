/**
 * GET /api/operators
 * Публичный каталог операторов (is_public = true).
 *
 * Query-логика вынесена в lib/operators/list-query.ts — общий data-слой с
 * SSR-рендером app/operators/page.tsx (шаг 3 аудита 11.07). Здесь остаётся
 * только HTTP-обёртка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { OperatorsQuerySchema, queryOperators } from '@/lib/operators/list-query';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const parsed = OperatorsQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неверные параметры запроса' }, { status: 400 });
  }

  const { page, limit } = parsed.data;

  try {
    const { items, meta } = await queryOperators(parsed.data);
    return NextResponse.json({ success: true, data: items, meta });
  } catch {
    // Исторический контракт: при недоступной БД листинг деградирует в пустой
    // список (200 + degraded), а не в 5xx — клиент показывает «не найдено».
    return NextResponse.json(
      {
        success: true,
        data: [],
        meta: { total: 0, page, limit, pages: 0 },
        degraded: true,
      },
      { status: 200 }
    );
  }
}
