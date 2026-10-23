import { NextResponse } from 'next/server';
import { loadHomeWeather } from '@/lib/weather/home-widget';

/**
 * GET /api/weather/home — виджет погоды главной, когда главная не дождалась
 * прогноза за свой бюджет (lib/weather/home-widget, исход «pending»).
 *
 * Тот же прогноз и то же правило, что при серверном рендере главной. Отказ —
 * 502 с исходом failed: виджет скажет «не загрузился», а не нарисует нули.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const w = await loadHomeWeather();
  return NextResponse.json(w, { status: w.kind === 'ok' ? 200 : 502 });
}
