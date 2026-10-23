'use client';

/**
 * Виджет погоды главной — длинная плитка между рядами «Своя поездка / Радар»
 * и «Туры / Трансфер / Жильё / Прокат» (слово владельца 23.10). Нажатие —
 * страница погоды /weather.
 *
 * Вид — стекло, как у соседних плиток ряда (слово владельца вечером 23.10:
 * «из-за виджета погоды теряется всё остальное»). Сцена неба на 98 px была
 * самым ярким и самым высоким пятном экрана; теперь в плитке колодец со знаком
 * погоды, крупная температура, небо, место и ветер, ближайшие дни. Место
 * названо: погода одной точки, а не всего края.
 * Данные и исходы — lib/weather/home-widget:
 *  - ok      — температура, небо, ветер, ближайшие дни; предупреждение
 *              Росгидромета полосой с кромкой --warning, только если оно есть;
 *  - pending — главная не дождалась прогноза: плитка той же высоты, данные
 *              дотягиваются из GET /api/weather/home;
 *  - failed  — «прогноз не загрузился», цифр нет, ссылка на страницу остаётся.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, CloudSun } from 'lucide-react';
import { ConditionIcon } from '@/components/weather/ConditionIcon';
import { HOME_WEATHER_ENDPOINT, type HomeWeather } from '@/lib/weather/home-widget-types';

/** «Петропавловск-Камчатский» → «Петропавловск»: в плитке — первое слово составного названия. */
const shortPlace = (name: string) => name.split('-')[0];

function isHomeWeather(v: unknown): v is HomeWeather {
  const k = (v as { kind?: unknown } | null)?.kind;
  return k === 'ok' || k === 'failed' || k === 'pending';
}

export function HomeWeatherStrip({ initial }: { initial: HomeWeather }) {
  const [w, setW] = useState<HomeWeather>(initial);

  useEffect(() => {
    if (initial.kind !== 'pending') return;
    let alive = true;
    fetch(HOME_WEATHER_ENDPOINT)
      .then((r) => r.json())
      .then((body: unknown) => {
        if (alive) setW(isHomeWeather(body) && body.kind === 'ok' ? body : { kind: 'failed' });
      })
      .catch((err: unknown) => {
        console.error('[home-weather] прогноз не дотянут:', err instanceof Error ? err.message : String(err));
        if (alive) setW({ kind: 'failed' });
      });
    return () => { alive = false; };
  }, [initial.kind]);

  if (w.kind === 'pending') {
    return (
      <Link href="/weather" className="hw" aria-label="Погода на Камчатке: прогноз загружается. Открыть прогноз на 7 дней" aria-busy="true">
        <span className="hw-row">
          <span className="hw-ic"><CloudSun size={18} aria-hidden /></span>
          <span className="hw-mid"><b>Погода</b><span>загружаем прогноз…</span></span>
        </span>
      </Link>
    );
  }

  if (w.kind === 'failed') {
    return (
      <Link href="/weather" className="hw" aria-label="Погода на Камчатке: прогноз сейчас не загрузился. Открыть страницу погоды">
        <span className="hw-row">
          <span className="hw-ic"><CloudSun size={18} aria-hidden /></span>
          <span className="hw-mid"><b>Погода на 7 дней</b><span>прогноз сейчас не загрузился</span></span>
        </span>
      </Link>
    );
  }

  const place = shortPlace(w.place);
  const second = w.staleFrom ? `прогноз от ${w.staleFrom}` : w.wind;
  const label = [
    `Погода: ${place}`,
    w.temp !== null ? `сейчас ${w.temp}°` : 'температура — нет данных',
    w.sky,
    second,
    w.warning ? `предупреждение: ${w.warning.title}${w.warning.count > 1 ? ` и ещё ${w.warning.count - 1}` : ''}` : null,
    'Открыть прогноз на 7 дней',
  ].filter(Boolean).join('. ');

  return (
    <Link href="/weather" className="hw" aria-label={label}>
      <span className="hw-row">
        <span className="hw-ic"><ConditionIcon code={w.code} isDay={w.isDay} size={18} /></span>
        <span className="hw-temp">{w.temp !== null ? `${w.temp}°` : '—'}</span>
        <span className="hw-mid">
          <b>{w.sky ? w.sky.charAt(0).toUpperCase() + w.sky.slice(1) : 'Сейчас'}</b>
          {/* Место и ветер переносятся целиком: «Петропавловск ·» / «ветер до 9 м/с»,
              а не посреди фразы. */}
          <span><span className="hw-nw">{place}</span>{second && <> · <span className="hw-nw">{second}</span></>}</span>
        </span>
        {w.days.length > 0 && (
          <span className="hw-days" aria-hidden>
            {w.days.map((d) => (
              <span className="hw-day" key={d.date}>
                <i>{d.weekday}</i>
                <ConditionIcon code={d.code} size={14} />
                <b>{d.max !== null ? `${d.max}°` : '—'}</b>
              </span>
            ))}
          </span>
        )}
      </span>
      {w.warning && (
        <span className="hw-warn">
          <AlertTriangle size={14} aria-hidden />
          <span className="hw-warn-t">{w.warning.title}</span>
          {w.warning.count > 1 && <span className="hw-warn-n">и ещё {w.warning.count - 1}</span>}
        </span>
      )}
    </Link>
  );
}
