import { NextRequest, NextResponse } from 'next/server';
import { allowFresh } from '@/lib/safety/refresh-throttle';

// Cache weather for 10 minutes
let cache: { data: Record<string, unknown>; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  // `?fresh=1` — кнопка «обновить»: кэш пропускается, но к wttr.in идём не
  // чаще, чем разрешает ограничитель. Из кэша ответ уходит с ЧЕСТНЫМ временем
  // проверки, а не с текущим: иначе кнопка обещала бы свежесть, которой нет.
  const wantFresh = request.nextUrl.searchParams.get('fresh') === '1' && allowFresh('weather');
  if (cache && (Date.now() - cache.ts < CACHE_TTL) && !wantFresh) {
    return NextResponse.json({ ...cache.data, checked_at: new Date(cache.ts).toISOString(), from_cache: true });
  }

  try {
    const res = await fetch(
      'https://wttr.in/Petropavlovsk-Kamchatsky?format=j1',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) {
      // В поле старая погода полезнее пустого экрана — но только названная
      // старой. Кэша нет — честный отказ.
      if (cache) return NextResponse.json({ ...cache.data, checked_at: new Date(cache.ts).toISOString(), from_cache: true, stale: true });
      return NextResponse.json({ error: 'Сервис погоды недоступен' }, { status: 502 });
    }
    const raw = await res.json() as {
      current_condition?: Array<{
        temp_C: string;
        FeelsLikeC: string;
        humidity: string;
        windspeedKmph: string;
        lang_ru?: Array<{ value: string }>;
        weatherDesc?: Array<{ value: string }>;
      }>;
    };
    const cur = raw.current_condition?.[0];
    if (!cur) {
      return NextResponse.json({ error: 'Нет данных от сервиса погоды' }, { status: 502 });
    }
    const data = {
      tempC: cur.temp_C,
      feelsLikeC: cur.FeelsLikeC,
      desc: cur.lang_ru?.[0]?.value || cur.weatherDesc?.[0]?.value || '—',
      humidity: cur.humidity,
      windKmph: cur.windspeedKmph,
      updatedAt: new Date().toISOString(),
    };
    const ts = Date.now();
    cache = { data, ts };
    return NextResponse.json({ ...data, checked_at: new Date(ts).toISOString(), from_cache: false });
  } catch {
    return NextResponse.json({ error: 'Не удалось загрузить прогноз погоды' }, { status: 502 });
  }
}
