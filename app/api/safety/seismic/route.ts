/**
 * GET /api/safety/seismic
 * Публичный. Приоритет — КБГС РАН из external_alerts (ingest каждые 20 мин).
 * Fallback — USGS если локальных данных нет. Логика вынесена в общий слой
 * lib/services/seismic-feed.ts (тот же источник использует Главная v8).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSeismicFeed, getQuakesForMap, QUAKE_MAP_MAX_HOURS } from '@/lib/services/safety/seismic-feed';
import { allowFresh } from '@/lib/safety/refresh-throttle';

export const dynamic = 'force-dynamic';

/** `?hours=N` — режим карты (02.10): все толчки с координатами за окно. */
const HoursSchema = z.coerce.number().int().min(1).max(QUAKE_MAP_MAX_HOURS);

export async function GET(request: NextRequest) {
  const hoursRaw = request.nextUrl.searchParams.get('hours');
  if (hoursRaw !== null) {
    const parsed = HoursSchema.safeParse(hoursRaw);
    if (!parsed.success) {
      return NextResponse.json({ error: `Окно — целое число часов от 1 до ${QUAKE_MAP_MAX_HOURS}` }, { status: 400 });
    }
    try {
      const events = await getQuakesForMap(parsed.data);
      return NextResponse.json({ events, hours: parsed.data, source: 'external_alerts' });
    } catch (err) {
      // «Не прочитали» — не «толчков не было» (§4.0): карта скажет это словами.
      const code = (err as { code?: string }).code ?? 'unknown';
      console.error(`[seismic] окно ${parsed.data} ч не прочитано: SQLSTATE ${code}`, err);
      return NextResponse.json({ error: 'Толчки временно недоступны', events: [] }, { status: 502 });
    }
  }
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
