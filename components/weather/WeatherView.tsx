import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AlertTriangle, Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun,
  Compass, Droplets, Eye, Gauge, MapPin, Moon, Phone, Sun, Sunrise, Sunset, Thermometer, Umbrella, Wind,
} from 'lucide-react';
import type { ForecastDay, ForecastHour } from '@/lib/planner/intelligence';
import { METEOALERT_PAGE } from '@/lib/services/safety/meteoalert';
import {
  DEFAULT_WEATHER_SLUG, WEATHER_GROUP_LABELS, WEATHER_PLACES, weatherPlaceHref, type WeatherPlaceGroup,
} from '@/lib/weather/places';
import type { MeteoWarningItem, PlaceWeather, WarningsRead, WeatherPageData } from '@/lib/weather/weather-page';
import {
  dayLabel, elevationLine, fmtNumber, fmtTemp, hhmm, kamchatkaTime, partPrecip, precipLine, pressureLine,
  rangeBar, skyWords, tempRange, uvWords, visibilityLine, windDetail, windDirectionWords, windLine,
} from '@/lib/weather/weather-format';
import { PRECIP_DRY_MM } from '@/lib/weather/day-parts';

/**
 * Страница погоды — виджет уровня погодных приложений внутри раздела
 * /weather (карт-бланш владельца на дизайн только этого раздела):
 * крупное «сейчас», почасовая лента, неделя со шкалой температур,
 * плитки деталей, части дня. Герой, часы, детали и неделя живут в одной
 * сцене: её градиент выбирается по is_day/восходу-закату и WMO-коду из
 * того же прогноза, плашки — полупрозрачное «стекло» поверх градиента.
 * Серверный рендер без скриптов: места
 * переключаются ссылками, части дня у дней — нативным details.
 * Показываются только поля, которые реально отдал Open-Meteo:
 * нет поля — нет плитки, а не выдуманный ноль.
 */

const LEVEL_COLOR: Record<MeteoWarningItem['severity'], string> = {
  1: 'var(--warning)',
  2: 'var(--accent)',
  3: 'var(--danger)',
};

const GROUPS: WeatherPlaceGroup[] = ['city', 'trail', 'settlement'];

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function ConditionIcon({ code, isDay, size = 22, wx = false }: { code: number | null; isDay?: boolean; size?: number; wx?: boolean }) {
  const cls = wx ? 'shrink-0 text-[var(--wx-icon)]' : 'shrink-0 text-[var(--ocean)]';
  if (code === null) return <Cloud size={size} aria-hidden className={cls} />;
  if (code === 0) return isDay === false ? <Moon size={size} aria-hidden className={cls} /> : <Sun size={size} aria-hidden className={cls} />;
  if (code <= 2) return isDay === false ? <CloudMoon size={size} aria-hidden className={cls} /> : <CloudSun size={size} aria-hidden className={cls} />;
  if (code === 3) return <Cloud size={size} aria-hidden className={cls} />;
  if (code <= 48) return <CloudFog size={size} aria-hidden className={cls} />;
  if (code >= 95) return <CloudLightning size={size} aria-hidden className={cls} />;
  if ((code >= 71 && code <= 77) || code >= 85) return <CloudSnow size={size} aria-hidden className={cls} />;
  return <CloudRain size={size} aria-hidden className={cls} />;
}

/* ── Предупреждения: компактный баннер наверх ─────────────────────────── */

function Warnings({ warnings }: { warnings: WarningsRead }) {
  const checked = warnings.kind !== 'failed' ? kamchatkaTime(warnings.checkedAt) : null;
  if (warnings.kind === 'ok' && warnings.items.length === 0) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text-primary)]">Действующих предупреждений нет</span>
        {checked ? <span>· проверено {checked} по Камчатке</span> : null}
        <span>· источник — <a href={METEOALERT_PAGE} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)]">Гидрометцентр</a></span>
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-4 sm:p-5" aria-labelledby="weather-warnings">
      <h2 id="weather-warnings" className="flex items-center gap-2 text-base font-semibold">
        <AlertTriangle size={20} aria-hidden className="text-[var(--warning)]" />
        Предупреждения Росгидромета
      </h2>
      {warnings.kind === 'failed' ? (
        <p className="text-[var(--text-secondary)]">
          Предупреждения прочитать не удалось. Это не «предупреждений нет» — проверьте их на сайте Гидрометцентра.
        </p>
      ) : (
        <>
          {warnings.kind === 'silent' && (
            <p className="border-l-2 border-[var(--warning)] pl-3 text-sm">
              Источник предупреждений не отвечает{checked ? ` с ${checked}` : ''}. Список ниже может быть неполным —
              сверьтесь с сайтом Гидрометцентра.
            </p>
          )}
          {warnings.items.length === 0 ? (
            <p>{warnings.kind === 'ok' ? 'Действующих предупреждений нет.' : 'Других предупреждений у нас нет, но это не значит, что их нет.'}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {warnings.items.map((w) => {
                const until = kamchatkaTime(w.until);
                return (
                  <li key={`${w.title}|${w.until}`} className="flex flex-col gap-1 border-l-4 pl-3" style={{ borderLeftColor: LEVEL_COLOR[w.severity] }}>
                    <span className="font-semibold">{w.title}</span>
                    {w.text && <span className="text-sm text-[var(--text-secondary)]">{w.text}</span>}
                    {until && <span className="text-sm text-[var(--text-muted)]">Действует до {until} по Камчатке</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <p className="text-sm text-[var(--text-secondary)]">
        {warnings.kind === 'ok' && checked ? `Проверено ${checked}. ` : ''}
        Источник —{' '}
        <a href={METEOALERT_PAGE} target="_blank" rel="noopener noreferrer" className="text-[var(--ocean)]">Гидрометцентр</a>.
        Все предупреждения края, включая МЧС, — на странице{' '}
        <Link href="/safety" className="text-[var(--ocean)]">Безопасность</Link>.
      </p>
    </section>
  );
}

/* ── Переключатель мест ───────────────────────────────────────────────── */

function PlaceSwitcher({ current, scene = false }: { current: string; scene?: boolean }) {
  return (
    <nav aria-label="Места" className="flex flex-col gap-2">
      {GROUPS.map((g) => (
        <div key={g} className="flex flex-col gap-1.5">
          <span className="ds-label">{WEATHER_GROUP_LABELS[g]}</span>
          <ul className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {WEATHER_PLACES.filter((p) => p.group === g).map((p) => {
              const active = p.slug === current;
              return (
                <li key={p.slug} className="shrink-0">
                  <Link
                    href={weatherPlaceHref(p)}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex min-h-[40px] items-center rounded-full border px-3 text-sm no-underline transition-colors duration-200 ${
                      scene
                        ? active
                          ? 'border-[var(--wx-icon)] bg-[var(--wx-glass-2)] font-semibold text-[var(--wx-fg)]'
                          : 'border-[var(--wx-glass-border)] bg-[var(--wx-chip)] text-[var(--wx-fg-2)] hover:bg-[var(--wx-glass-2)] hover:text-[var(--wx-fg)]'
                        : active
                          ? 'border-[var(--accent)] bg-[var(--accent-muted)] font-semibold text-[var(--text-primary)]'
                          : 'border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {p.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/* ── Герой: сейчас ────────────────────────────────────────────────────── */

type OkWeather = Extract<PlaceWeather, { kind: 'ok' }>;

function currentHour(w: OkWeather): ForecastHour | null {
  if (!w.hours || w.hours.length === 0) return null;
  const prefix = w.now?.time ? w.now.time.slice(0, 13) : null;
  if (prefix) {
    const hit = w.hours.find((h) => h.time.startsWith(prefix));
    if (hit) return hit;
  }
  return w.hours[0];
}

/* ── Сцена героя: период и небо из уже имеющихся данных ───────────────── */

export type WeatherSky = 'clear' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

export function weatherSky(code: number | null): WeatherSky {
  if (code === null) return 'cloud';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloud';
  if (code <= 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

/**
 * День или ночь для сцены: сначала is_day источника; если его нет —
 * местное время прогноза между восходом и закатом этого дня; дальше —
 * час того же местного времени. Новых данных сцена не просит.
 */
export function weatherScene(w: OkWeather, today: string): { name: string; period: 'day' | 'night'; sky: WeatherSky } {
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const code = w.now?.weatherCode ?? hour?.weatherCode ?? day?.weatherCode ?? null;
  const sky = weatherSky(code);
  let period: 'day' | 'night' | null = null;
  if (w.now?.isDay === true) period = 'day';
  else if (w.now?.isDay === false) period = 'night';
  if (period === null) {
    const nowHm = hhmm(w.now?.time ?? hour?.time);
    const sunrise = hhmm(day?.sunrise);
    const sunset = hhmm(day?.sunset);
    if (nowHm && sunrise && sunset) period = nowHm >= sunrise && nowHm < sunset ? 'day' : 'night';
    else if (nowHm) {
      const h = Number(nowHm.slice(0, 2));
      period = h >= 7 && h < 20 ? 'day' : 'night';
    }
  }
  const resolved = period ?? 'day';
  return { name: `${resolved}-${sky}`, period: resolved, sky };
}

/** Силуэт Камчатки одним слоем: дальняя гряда и конус вулкана. */
function SceneSilhouette() {
  return (
    <svg className="wx-silhouette-svg" viewBox="0 0 1440 340" preserveAspectRatio="none" aria-hidden focusable="false">
      <path fill="currentColor" opacity="0.55" d="M0 258 L180 208 L360 244 L560 188 L760 240 L980 204 L1180 250 L1440 214 L1440 340 L0 340 Z" />
      <path fill="currentColor" opacity="0.85" d="M848 340 L1112 108 L1168 70 L1206 94 L1242 70 L1302 114 L1440 258 L1440 340 Z" />
      <path fill="currentColor" opacity="0.8" d="M0 340 L0 286 L238 250 L428 300 L624 340 Z" />
    </svg>
  );
}

function Hero({ w, today }: { w: OkWeather; today: string }) {
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const nowTemp = w.now?.temp ?? hour?.temp ?? null;
  const apparent = w.now?.apparent ?? hour?.apparent ?? null;
  const description = w.now?.description ?? hour?.description ?? (day ? skyWords(day) : null);
  const code = w.now?.weatherCode ?? hour?.weatherCode ?? day?.weatherCode ?? null;
  const elevation = elevationLine(w.elevationM);
  const stale = kamchatkaTime(w.staleSince);
  return (
    <section aria-labelledby="weather-now" className="pt-1 text-center sm:pt-2">
      <div className="flex flex-col items-center gap-1">
        <h2 id="weather-now" className="flex items-center justify-center gap-2 text-xl font-semibold sm:text-2xl">
          <MapPin size={22} aria-hidden className="text-[var(--wx-icon)]" />
          {w.place.name}
        </h2>
        <p className="text-sm text-[var(--wx-fg-2)]">
          <span className="tabular-nums">{w.lat.toFixed(2)}, {w.lng.toFixed(2)}</span>
          {elevation ? ` · ${elevation}` : ''}
          {day ? <span className="text-[var(--wx-fg-3)]"> · {dayLabel(day.date, today)}</span> : null}
        </p>
      </div>

      {stale && (
        <p className="wx-glass-soft mx-auto mt-3 max-w-xl rounded-2xl border-l-2 px-3 py-2 text-left text-sm" style={{ borderLeftColor: 'var(--wx-icon)' }}>
          Источник прогноза сейчас не отвечает. Это последний полученный прогноз — от {stale} по Камчатке.
        </p>
      )}

      <p className="mt-2 text-[5.5rem] font-light leading-[0.95] tabular-nums sm:text-[7.5rem]" aria-label={nowTemp !== null ? `Сейчас ${fmtTemp(nowTemp)} градусов` : undefined}>
        {nowTemp !== null ? `${fmtTemp(nowTemp)}°` : '—'}
      </p>
      <div className="mt-2 flex flex-col items-center gap-1">
        <span className="flex items-center justify-center gap-2 text-xl font-medium sm:text-2xl">
          <ConditionIcon code={code} isDay={w.now?.isDay ?? undefined} size={32} wx />
          {description ?? 'Условия — нет данных'}
        </span>
        {apparent !== null && <span className="text-[var(--wx-fg-2)]">Ощущается как {fmtTemp(apparent)}°</span>}
        {day && (day.tempMin !== null || day.tempMax !== null) && (
          <span className="tabular-nums text-[var(--wx-fg-2)]" aria-label={`Сегодня ${tempRange(day.tempMin, day.tempMax) ?? 'температура — нет данных'}`}>
            {day.tempMax !== null ? <span aria-hidden>↑{fmtTemp(day.tempMax)}°</span> : null}
            {day.tempMax !== null && day.tempMin !== null ? <span aria-hidden> · </span> : null}
            {day.tempMin !== null ? <span aria-hidden>↓{fmtTemp(day.tempMin)}°</span> : null}
          </span>
        )}
        {day && day.tempMin === null && day.tempMax === null && (
          <span className="tabular-nums text-[var(--wx-fg-2)]">Сегодня температура — нет данных</span>
        )}
        {w.now?.time && <span className="text-sm text-[var(--wx-fg-3)]">По прогнозу на {hhmm(w.now.time) ?? ''} местного времени</span>}
      </div>
    </section>
  );
}

/* ── Почасовая лента ──────────────────────────────────────────────────── */

function HourlyStrip({ w }: { w: OkWeather }) {
  const start = currentHour(w);
  if (!start) return null;
  const from = (w.hours ?? []).findIndex((h) => h.time === start.time);
  const hours = (w.hours ?? []).slice(from < 0 ? 0 : from, (from < 0 ? 0 : from) + 24);
  if (hours.length === 0) return null;
  return (
    <section aria-labelledby="weather-hourly" className="flex flex-col gap-2">
      <h2 id="weather-hourly" className="ds-h2">По часам</h2>
      <div className="wx-glass overflow-x-auto rounded-[1.75rem]" tabIndex={0} aria-label="Почасовой прогноз, прокручивается вбок">
        <ol className="flex min-w-max">
          {hours.map((h, i) => (
            <li
              key={h.time}
              className={`flex w-[76px] shrink-0 flex-col items-center gap-1 px-2 py-3 text-center ${i === 0 ? 'bg-[var(--wx-glass-2)]' : ''}`}
            >
              <span className="text-sm font-medium tabular-nums">{i === 0 ? 'Сейчас' : (hhmm(h.time) ?? '')}</span>
              <ConditionIcon code={h.weatherCode} size={22} wx />
              <span className="text-base font-semibold tabular-nums">{h.temp !== null ? `${fmtTemp(h.temp)}°` : '—'}</span>
              <span className="flex items-center gap-0.5 text-xs tabular-nums text-[var(--wx-icon)]">
                <Droplets size={12} aria-hidden />
                {h.precipProb !== null ? `${Math.round(h.precipProb)}%` : '—'}
              </span>
              <span className="text-xs tabular-nums text-[var(--wx-fg-3)]">
                {h.precipMm !== null && h.precipMm >= PRECIP_DRY_MM ? `${fmtNumber(h.precipMm)} мм` : ''}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ── Плитки деталей ───────────────────────────────────────────────────── */

function DetailTiles({ w, today }: { w: OkWeather; today: string }) {
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const tiles: Array<{ icon: ReactNode; label: string; value: string; hint?: string }> = [];
  const apparent = w.now?.apparent ?? hour?.apparent ?? null;
  if (apparent !== null) tiles.push({ icon: <Thermometer size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Ощущается как', value: `${fmtTemp(apparent)}°` });
  const wind = windDetail(w.now?.windKmh ?? hour?.windKmh, w.now?.windGustKmh ?? hour?.windGustKmh, w.now?.windDirDeg ?? hour?.windDirDeg);
  if (wind !== 'нет данных') {
    const dir = windDirectionWords(w.now?.windDirDeg ?? hour?.windDirDeg);
    tiles.push({ icon: <Wind size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Ветер', value: wind, hint: dir ? `Ветер ${dir}` : undefined });
  }
  const humidity = w.now?.humidity ?? hour?.humidity ?? null;
  if (humidity !== null) tiles.push({ icon: <Droplets size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Влажность', value: `${Math.round(humidity)}%` });
  // Оба поля — pressure_msl (приведённое к уровню моря); surface_pressure сюда не попадает, при отсутствии приведённого плитки нет.
  const pressure = w.now?.pressureHpa ?? hour?.pressureHpa ?? null;
  if (pressure !== null) tiles.push({ icon: <Gauge size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Давление', value: pressureLine(pressure), hint: 'к уровню моря' });
  if (day) {
    tiles.push({
      icon: <Umbrella size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Осадки сегодня',
      value: precipLine(day.precipMm),
      hint: day.precipProbMax !== null && day.precipProbMax !== undefined ? `вероятность до ${Math.round(day.precipProbMax)}%` : undefined,
    });
  }
  if (hour?.cloudCover !== null && hour?.cloudCover !== undefined) {
    tiles.push({ icon: <Cloud size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Облачность', value: `${Math.round(hour.cloudCover)}%` });
  }
  if (hour?.visibilityM !== null && hour?.visibilityM !== undefined) {
    tiles.push({ icon: <Eye size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Видимость', value: visibilityLine(hour.visibilityM) });
  }
  const uv = day?.uvIndexMax ?? hour?.uvIndex ?? null;
  if (uv !== null && uv !== undefined) {
    tiles.push({ icon: <Sun size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'УФ-индекс', value: uvWords(uv), hint: day?.uvIndexMax ? 'максимум за день' : undefined });
  }
  const sunrise = hhmm(day?.sunrise);
  const sunset = hhmm(day?.sunset);
  if (sunrise || sunset) {
    tiles.push({
      icon: <Sunrise size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Световой день',
      value: [sunrise ? `восход ${sunrise}` : null, sunset ? `закат ${sunset}` : null].filter(Boolean).join(' · '),
      hint: undefined,
    });
  }
  if (sunset && !sunrise) tiles[tiles.length - 1].icon = <Sunset size={20} aria-hidden className="text-[var(--wx-icon)]" />;
  const dirNow = windDirectionWords(w.now?.windDirDeg ?? hour?.windDirDeg);
  if (dirNow && wind === 'нет данных') {
    tiles.push({ icon: <Compass size={20} aria-hidden className="text-[var(--wx-icon)]" />, label: 'Направление ветра', value: dirNow });
  }
  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby="weather-details" className="flex flex-col gap-2">
      <h2 id="weather-details" className="ds-h2">Сейчас в деталях</h2>
      <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <li key={t.label} className="wx-glass flex min-h-[88px] flex-col gap-1 rounded-[1.5rem] p-3">
            <span className="flex items-center gap-2 text-sm text-[var(--wx-fg-2)]">{t.icon}{t.label}</span>
            <span className="text-base font-semibold leading-snug">{t.value}</span>
            {t.hint && <span className="text-sm text-[var(--wx-fg-3)]">{t.hint}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Неделя ───────────────────────────────────────────────────────────── */

function DayPartsBlock({ d }: { d: ForecastDay }) {
  const parts = d.parts ?? [];
  if (parts.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="flex min-h-[40px] cursor-pointer items-center text-sm font-medium text-[var(--wx-icon)]">По частям дня</summary>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        {parts.map((p) => (
          <div key={p.label} className="wx-glass-soft flex flex-col gap-0.5 rounded-2xl p-2.5">
            <dt className="ds-label">{p.label}</dt>
            <dd className="text-sm tabular-nums">{tempRange(p.tempMin, p.tempMax) ?? 'нет данных'}</dd>
            <dd className="text-sm text-[var(--wx-fg-2)]">{partPrecip(p)}</dd>
            <dd className="text-xs text-[var(--wx-fg-3)]">{windLine(p.windKmh)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function WeekForecast({ w, today }: { w: OkWeather; today: string }) {
  const mins = w.days.map((d) => d.tempMin).filter((v): v is number => v !== null);
  const maxs = w.days.map((d) => d.tempMax).filter((v): v is number => v !== null);
  const weekMin = mins.length ? Math.min(...mins) : null;
  const weekMax = maxs.length ? Math.max(...maxs) : null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="weather-week">
      <h2 id="weather-week" className="ds-h2">На 7 дней</h2>
      <ol className="wx-glass flex flex-col divide-y divide-[var(--wx-glass-border)] rounded-[1.5rem] px-3 sm:px-4">
        {w.days.map((d) => {
          const bar = rangeBar(d.tempMin, d.tempMax, weekMin, weekMax);
          const sky = skyWords(d);
          return (
            <li key={d.date} className="py-2.5 first:pt-3 last:pb-3">
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 font-semibold sm:w-32">{dayLabel(d.date, today)}</span>
                <ConditionIcon code={d.weatherCode} size={22} wx />
                <span className="hidden min-w-0 flex-1 truncate text-sm text-[var(--wx-fg-2)] sm:block">
                  {[sky, precipLine(d.precipMm), windLine(d.windKmh)].filter(Boolean).join(' · ')}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums sm:ml-0">
                  <span className="text-[var(--wx-fg-2)]">{d.tempMin !== null ? `${fmtTemp(d.tempMin)}°` : '—'}</span>
                  <span className="relative h-2 w-20 overflow-hidden rounded-full bg-[var(--wx-track)] sm:w-28" aria-hidden>
                    {bar && (
                      <span
                        className="absolute top-0 h-full rounded-full"
                        style={{ left: `${bar.left}%`, width: `${bar.width}%`, background: 'linear-gradient(90deg, var(--wx-icon), var(--accent))' }}
                      />
                    )}
                  </span>
                  <span className="font-semibold">{d.tempMax !== null ? `${fmtTemp(d.tempMax)}°` : '—'}</span>
                </span>
              </div>
              <p className="mt-0.5 pl-[108px] text-sm text-[var(--wx-fg-2)] sm:hidden">
                {[sky, precipLine(d.precipMm), windLine(d.windKmh)].filter(Boolean).join(' · ')}
              </p>
              <p className="sr-only">{tempRange(d.tempMin, d.tempMax) ?? 'температура — нет данных'}</p>
              <div className="pl-0 sm:pl-[108px]"><DayPartsBlock d={d} /></div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ── Все места ────────────────────────────────────────────────────────── */

/** «+2…+7°, 0,8 мм, до 13 м/с» — день одной строкой для списка мест. */
function shortDay(d: ForecastDay | undefined): string {
  if (!d) return 'нет в прогнозе';
  const t = tempRange(d.tempMin, d.tempMax) ?? 'температура —';
  const p = d.precipMm === null ? 'осадки —' : d.precipMm < PRECIP_DRY_MM ? 'без осадков' : `${fmtNumber(d.precipMm)} мм`;
  const wind = d.windKmh === null ? 'ветер —' : `до ${Math.round(d.windKmh / 3.6)} м/с`;
  return `${t}, ${p}, ${wind}`;
}

function Overview({ all, today, current }: { all: PlaceWeather[]; today: string; current: string }) {
  const tomorrow = addDays(today, 1);
  return (
    <section className="ds-section flex flex-col gap-2" aria-labelledby="weather-all">
      <h2 id="weather-all" className="ds-h2 flex items-center gap-2">
        <CloudSun size={20} aria-hidden className="text-[var(--ocean)]" />
        Все места: сегодня и завтра
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {all.map((w) => {
          const todayDay = w.kind === 'ok' ? w.days.find((d) => d.date === today) : undefined;
          return (
            <li key={w.place.slug}>
              <Link
                href={weatherPlaceHref(w.place)}
                aria-current={w.place.slug === current ? 'page' : undefined}
                className="flex min-h-[44px] flex-col gap-1.5 rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-4 no-underline transition-colors duration-200 hover:bg-[var(--bg-hover)]"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[var(--text-primary)]">{w.place.name}</span>
                  {w.kind === 'ok' && todayDay && <ConditionIcon code={todayDay.weatherCode} size={22} />}
                </span>
                {w.kind === 'ok' && w.elevationM !== null && w.elevationM >= 500 && (
                  <span className="text-xs text-[var(--text-muted)]">точка на ~{Math.round(w.elevationM / 10) * 10} м</span>
                )}
                {w.kind === 'ok' ? (
                  <span className="flex flex-col gap-0.5 text-sm text-[var(--text-secondary)] tabular-nums">
                    <span>Сегодня {shortDay(todayDay)}</span>
                    <span>Завтра {shortDay(w.days.find((d) => d.date === tomorrow))}</span>
                  </span>
                ) : (
                  <span className="text-sm text-[var(--text-secondary)]">
                    {w.kind === 'missing' ? 'места нет в справочнике' : 'прогноз не получили'}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SelectedFallback({ w }: { w: PlaceWeather }) {
  if (w.kind === 'ok') return null;
  return (
    <section className="rounded-3xl border border-[var(--border)] bg-[var(--bg-card)] p-5" aria-labelledby="weather-place">
      <h2 id="weather-place" className="flex items-center gap-2 text-lg font-semibold">
        <MapPin size={20} aria-hidden className="text-[var(--ocean)]" />
        {w.place.name}
      </h2>
      <p className="mt-2 text-[var(--text-secondary)]">
        {w.kind === 'missing'
          ? 'Этого места нет в справочнике платформы — прогноз именно для него дать не можем.'
          : `Прогноз не получили (${w.reason}). Попробуйте позже; погоду по памяти не называем.`}
      </p>
    </section>
  );
}

function SourceNote({ w }: { w: PlaceWeather }) {
  const fetched = w.kind === 'ok' && !w.staleSince ? kamchatkaTime(w.fetchedAt) : null;
  return (
    <section className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]" aria-labelledby="weather-source">
      <h2 id="weather-source" className="ds-h2 text-[var(--text-primary)]">Откуда прогноз</h2>
      <p>
        Open-Meteo по координатам места. Осадки — модель GFS: по замеру на метеостанции Петропавловска за 89 суток
        она верно говорила «сухо или осадки» в 89 днях из 100, сводная модель — в 80. Температура, ветер и небо —
        сводная модель Open-Meteo. Ветер — наибольший за сутки или часть дня.
      </p>
      <p>
        {fetched ? `Прогноз получен ${fetched} по Камчатке и обновляется раз в три часа. ` : 'Прогноз обновляется раз в три часа. '}
        В горах погода меняется быстрее прогноза. Перед выходом на маршрут —{' '}
        <Link href="/register" className="text-[var(--ocean)]">регистрация в МЧС</Link>.
      </p>
    </section>
  );
}

export function WeatherView({ data }: { data: WeatherPageData }) {
  const place = data.selected.place;
  const isDefault = place.slug === DEFAULT_WEATHER_SLUG;
  const selected = data.selected;
  const scene = selected.kind === 'ok' ? weatherScene(selected, data.today) : null;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:gap-6">
      <header className="flex flex-col gap-2">
        <p className="ds-label">Камчатка · прогноз на 7 дней</p>
        <h1 className="ds-h1" style={{ fontFamily: 'var(--font-playfair)' }}>
          {isDefault ? 'Погода на Камчатке' : `Погода ${place.where}`}
        </h1>
        <p className="max-w-xl text-[var(--text-secondary)]">
          Прогноз по местам, куда ходят на Камчатке: по дням и по частям дня. Где источник не ответил, так и написано.
        </p>
      </header>

      <Warnings warnings={data.warnings} />

      {selected.kind === 'ok' ? (
        <div
          className="wx-scene flex flex-col gap-4 p-3 sm:gap-5 sm:p-5"
          data-wx-scene={scene?.name}
          data-wx-period={scene?.period}
          data-wx-sky={scene?.sky}
        >
          <SceneSilhouette />
          <Hero w={selected} today={data.today} />
          <PlaceSwitcher current={place.slug} scene />
          <HourlyStrip w={selected} />
          <DetailTiles w={selected} today={data.today} />
          <WeekForecast w={selected} today={data.today} />
        </div>
      ) : (
        <>
          <PlaceSwitcher current={place.slug} />
          <SelectedFallback w={selected} />
        </>
      )}
      <Overview all={data.all} today={data.today} current={place.slug} />
      <SourceNote w={data.selected} />

      <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Phone size={16} aria-hidden />
        Экстренный телефон 112. В беде на маршруте — кнопка SOS в шапке.
      </p>
    </div>
  );
}
