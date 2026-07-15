/**
 * GET /api/safety/seismic
 * Публичный. Приоритет — КБГС РАН из external_alerts (ingest каждые 20 мин).
 * Fallback — USGS если локальных данных нет. Логика вынесена в общий слой
 * lib/services/seismic-feed.ts (тот же источник использует Главная v8).
 */
import { NextResponse } from 'next/server';
import { getSeismicFeed } from '@/lib/services/seismic-feed';

export const dynamic = 'force-dynamic';

export async function GET() {
  const feed = await getSeismicFeed();
  if (feed.source === 'none') {
    return NextResponse.json(
      { error: 'Данные временно недоступны', events: [], source: 'none' },
      { status: 502 },
    );
  }
  return NextResponse.json(feed);
}
