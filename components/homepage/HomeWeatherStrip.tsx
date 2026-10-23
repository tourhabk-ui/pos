'use client';

/**
 * Виджет погоды главной — длинная плитка между рядами «Своя поездка / Радар»
 * и «Туры / Трансфер / Жильё / Прокат» (слово владельца 23.10). Нажатие —
 * страница погоды /weather.
 *
 * Вид — та же сцена, что у героя /weather (.wx-scene: фон по небу и времени
 * суток, звёзды ночью, силуэт гряды): плитка — окно в страницу, куда ведёт.
 * Данные и исходы — lib/weather/home-widget:
 *  - ok      — температура, небо, ветер, ближайшие дни; предупреждение
 *              Росгидромета строкой с кромкой --warning, только если оно есть;
 *  - pending — главная не дождалась прогноза: плитка той же высоты, данные
 *              дотягиваются из GET /api/weather/home;
 *  - failed  — «прогноз не загрузился», цифр нет, ссылка на страницу остаётся.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, CloudSun } from 'lucide-react';
import { ConditionIcon } from '@/components/weather/ConditionIcon';
import { HOME_WEATHER_ENDPOINT, type HomeWeather } from '@/lib/weather/home-widget-types';

/** «Петропавловск-Камчатский» → «Петропавловск»: в плитке — первое слово составного названия. */
const shortPlace = (name: string) => name.split('-')[0];

function isHomeWeather(v: unknown): v is HomeWeather {
  const k = (v as { kind?: unknown } | null)?.kind;
  return k === 'ok' || k === 'failed' || k === 'pending';
}

function Hills() {
  return (
    <svg className="hw-hills" viewBox="0 0 400 48" preserveAspectRatio="none" aria-hidden focusable="false">
      <path d="M0 40 L60 30 L120 36 L190 24 L250 34 L300 14 L318 8 L334 13 L400 30 L400 48 L0 48 Z" />
    </svg>
  );
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
      <Link href="/weather" className="hw wx-scene" data-wx-scene="day-cloud" data-wx-period="day" data-wx-sky="cloud" aria-label="Погода на Камчатке: прогноз загружается. Открыть прогноз на 7 дней" aria-busy="true">
        <Hills />
        <span className="hw-row">
          <span className="hw-now"><CloudSun size={30} aria-hidden className="text-[var(--wx-icon)]" /></span>
          <span className="hw-mid"><b>Погода</b><span>загружаем прогноз…</span></span>
          <ChevronRight className="hw-go" size={16} aria-hidden />
        </span>
      </Link>
    );
  }

  if (w.kind === 'failed') {
    return (
      <Link href="/weather" className="hw hw-off" aria-label="Погода на Камчатке: прогноз сейчас не загрузился. Открыть страницу погоды">
        <span className="hw-row">
          <span className="hw-now"><CloudSun size={26} aria-hidden className="text-[var(--ocean)]" /></span>
          <span className="hw-mid"><b>Погода на 7 дней</b><span>прогноз сейчас не загрузился</span></span>
          <ChevronRight className="hw-go" size={16} aria-hidden />
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
    <Link
      href="/weather"
      className="hw wx-scene"
      data-wx-scene={w.scene}
      data-wx-period={w.period}
      data-wx-sky={w.skyKind}
      aria-label={label}
    >
      <Hills />
      <span className="hw-cap">Погода · {place}</span>
      <span className="hw-row">
        <span className="hw-now">
          <ConditionIcon code={w.code} isDay={w.isDay} size={30} wx />
          <span className="hw-temp">{w.temp !== null ? `${w.temp}°` : '—'}</span>
        </span>
        <span className="hw-mid">
          <b>{w.sky ? w.sky.charAt(0).toUpperCase() + w.sky.slice(1) : 'Сейчас'}</b>
          {second && <span>{second}</span>}
        </span>
        {w.days.length > 0 && (
          <span className="hw-days" aria-hidden>
            {w.days.map((d) => (
              <span className="hw-day" key={d.date}>
                <i>{d.weekday}</i>
                <ConditionIcon code={d.code} size={16} wx />
                <b>{d.max !== null ? `${d.max}°` : '—'}</b>
              </span>
            ))}
          </span>
        )}
        <ChevronRight className="hw-go" size={16} aria-hidden />
      </span>
      {w.warning && (
        <span className="hw-warn">
          <AlertTriangle size={13} aria-hidden />
          <span className="hw-warn-t">{w.warning.title}</span>
          {w.warning.count > 1 && <span className="hw-warn-n">и ещё {w.warning.count - 1}</span>}
        </span>
      )}
    </Link>
  );
}
