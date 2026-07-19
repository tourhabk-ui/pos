/**
 * GET /api/weather/zones — погода шести погодных зон Камчатки для карточек
 * витрины. Один запрос с клиента на всю сетку: карточка сама выбирает
 * ближайшую зону (nearestZoneKey). Источник — wttr.in, кэш 30 минут в
 * zone-weather; зоны без ответа честно отсутствуют в списке.
 */

import { NextResponse } from 'next/server';
import { getAllZonesWeather, ZONES } from '@/lib/services/zone-weather';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const zones = await getAllZonesWeather();
  return NextResponse.json(
    {
      success: true,
      zones: zones.map((w) => ({
        key: w.key,
        lat: ZONES[w.key].lat,
        lon: ZONES[w.key].lon,
        tempC: w.tempC,
        windKmh: w.windKmh,
        descRu: w.descRu,
      })),
    },
    { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=900' } },
  );
}
