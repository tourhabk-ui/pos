/**
 * GET /api/hub/marketplace/tours
 * Public API: Get all available tours for marketplace
 *
 * Query-логика вынесена в lib/tours/marketplace-query.ts — общий data-слой с
 * SSR-рендером app/catalog/page.tsx (шаг 3 аудита 11.07). Здесь остаётся
 * только HTTP-обёртка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { MarketplaceToursQuerySchema, queryMarketplaceTours } from '@/lib/tours/marketplace-query';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const raw = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = MarketplaceToursQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const { tours, total } = await queryMarketplaceTours(parsed.data);
    const res = NextResponse.json({
      success: true,
      tours,
      total,
      count: tours.length,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'Failed to fetch tours', detail: message },
      { status: 500 },
    );
  }
}
