/**
 * GET /api/safety/seismic
 * Публичный. Приоритет — КБГС РАН из external_alerts (ingest каждые 20 мин).
 * Fallback — USGS если локальных данных нет. Логика вынесена в общий слой
 * lib/services/seismic-feed.ts (тот же источник использует Главная v8).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSeismicFeed } from '@/lib/services/safety/seismic-feed';
import { allowFresh } from '@/lib/safety/refresh-throttle';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // `?fresh=1` — кнопка «обновить» на экране безопасности. Кэш пропускается,
  // но обращение к чужому источнику проходит через ограничитель: экран
  // публичный, и нетерпеливый палец не должен превращаться в поток запросов к
  // USGS. Придержали — ответ придёт из кэша и честно помечен fromCache.
  const wantFresh = request.nextUrl.searchParams.get('fresh') === '1';
  const feed = await getSeismicFeed({ fresh: wantFresh && allowFresh('seismic') });
  if (feed.source === 'none') {
    return NextResponse.json(
      { error: 'Данные временно недоступны', events: [], source: 'none' },
      { status: 502 },
    );
  }
  return NextResponse.json(feed);
}
