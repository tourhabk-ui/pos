import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AlertTriangle, CalendarDays, ChevronDown, Clock, Cloud, CloudSun,
  Compass, Droplets, Eye, Gauge, MapPin, Phone, Sun, Sunrise, Thermometer, Umbrella, Wind,
} from 'lucide-react';
import type { ForecastDay } from '@/lib/planner/intelligence';
import { METEOALERT_PAGE } from '@/lib/services/safety/meteoalert';
import {
  DEFAULT_WEATHER_SLUG, WEATHER_GROUP_LABELS, WEATHER_PLACES, weatherPlaceHref, type WeatherPlaceGroup,
} from '@/lib/weather/places';
import type { MeteoWarningItem, PlaceWeather, WarningsRead, WeatherPageData } from '@/lib/weather/weather-page';
import {
  dayLabel, elevationLine, fmtNumber, fmtTemp, hhmm, kamchatkaTime, partPrecip, precipLine, pressureMm,
  skyWords, tempRange, uvWords, visibilityLine, warningsSummary, windDirectionWords, windLine,
} from '@/lib/weather/weather-format';
import { PRECIP_DRY_MM } from '@/lib/weather/day-parts';
import { currentHour, weatherScene, type OkWeather } from '@/lib/weather/scene';
import { ConditionIcon } from '@/components/weather/ConditionIcon';

// Страница погоды отдаёт правила сцены и наружу: их судят тесты страницы.
export { weatherScene, weatherSky, type WeatherSky } from '@/lib/weather/scene';
import {
  arcPoint, daylightFraction, minutesOf, ringDash, tempCurve, uvMarkerPercent, windArrowRotation,
} from '@/lib/weather/wx-instruments';

/**
 * Страница погоды в стиле Samsung Weather (слово владельца 22.10: «сделай в
 * стиле самсунг погода»; карт-бланш на дизайн этого раздела — 08.10).
 *
 * Сцена на всю ширину телефона: градиент по is_day/восходу-закату и WMO-коду
 * того же прогноза, поверх неё — заголовок, крупная температура слева и знак
 * погоды справа, предупреждения, лента часов с линией температуры, неделя
 * строками «день · вероятность осадков · знак · макс/мин» и плитки-приборы:
 * компас ветра, дуга солнца, кольцо влажности, шкала УФ. Плашки —
 * полупрозрачное «стекло» поверх градиента (§2: поверх подложки — стекло).
 *
 * Серверный рендер без скриптов: места переключаются ссылками, части дня у
 * дней — нативным details, приборы — SVG, посчитанный на сервере
 * (lib/weather/wx-instruments). Показываются только поля, которые реально
 * отдал Open-Meteo: нет поля — нет плитки и нет прибора, а не выдуманный ноль.
 */

const LEVEL_COLOR: Record<MeteoWarningItem['severity'], string> = {
  1: 'var(--warning)',
  // Не --accent: в светлой теме он синий (globals.css, .wx-alerts).
  2: 'var(--wx-level-orange)',
  3: 'var(--danger)',
};

const GROUPS: WeatherPlaceGroup[] = ['city', 'trail', 'settlement'];

/** Ширина колонки часа и высота полосы с линией температуры, px. */
const HOUR_COL = 64;
const CURVE_H = 72;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** День ли в этот час — по восходу и закату его дня; не знаем — undefined. */
function isDayAt(time: string | null | undefined, days: ForecastDay[]): boolean | undefined {
  if (!time) return undefined;
  const d = days.find((x) => time.startsWith(x.date));
  const cur = minutesOf(hhmm(time));
  const rise = minutesOf(hhmm(d?.sunrise));
  const set = minutesOf(hhmm(d?.sunset));
  if (cur === null || rise === null || set === null) return undefined;
  return cur >= rise && cur < set;
}

/* ── Предупреждения: стекло с кромкой предупреждения в сцене ──────────── */

function Warnings({ warnings, scene = false }: { warnings: WarningsRead; scene?: boolean }) {
  const checked = warnings.kind !== 'failed' ? kamchatkaTime(warnings.checkedAt) : null;
  const link = scene ? 'text-[var(--wx-fg)] underline underline-offset-2' : 'text-[var(--ocean)]';
  const muted = scene ? 'text-[var(--wx-fg-2)]' : 'text-[var(--text-secondary)]';
  const faint = scene ? 'text-[var(--wx-fg-3)]' : 'text-[var(--text-muted)]';
  const strong = scene ? 'text-[var(--wx-fg)]' : 'text-[var(--text-primary)]';
  if (warnings.kind === 'ok' && warnings.items.length === 0) {
    return (
      <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl px-4 py-3 text-sm ${muted} ${
        scene ? 'wx-glass-soft' : 'border border-[var(--border)] bg-[var(--bg-card)]'
      }`}>
        <span className={`font-medium ${strong}`}>Действующих предупреждений нет</span>
        {checked ? <span>· проверено {checked} по Камчатке</span> : null}
        <span>· источник — <a href={METEOALERT_PAGE} target="_blank" rel="noopener noreferrer" className={link}>Гидрометцентр</a></span>
      </p>
    );
  }
  const sectionClass = `wx-alerts flex flex-col gap-3 p-4 sm:p-5 ${
    scene ? 'wx-glass rounded-[1.5rem]' : 'rounded-3xl border border-[var(--border)] bg-[var(--bg-card)]'
  }`;
  // Предупреждение на стекле узнаётся кромкой цвета предупреждения (§2). Ширина — здесь же:
  // рамка .wx-glass в globals.css перебивает утилиту border-l-4.
  const sectionStyle = scene ? { borderLeftColor: 'var(--warning)', borderLeftWidth: 4 } : undefined;
  const silentNote = warnings.kind === 'silent' ? (
    <span className="block border-l-2 border-[var(--warning)] pl-3 text-sm">
      Источник предупреждений не отвечает{checked ? ` с ${checked}` : ''}. Список ниже может быть неполным —
      сверьтесь с сайтом Гидрометцентра.
    </span>
  ) : null;
  const source = (
    <p className={`text-sm ${muted}`}>
      {warnings.kind === 'ok' && checked ? `Проверено ${checked}. ` : ''}
      Источник —{' '}
      <a href={METEOALERT_PAGE} target="_blank" rel="noopener noreferrer" className={link}>Гидрометцентр</a>.
      Все предупреждения края, включая МЧС, — на странице{' '}
      <Link href="/safety" className={link}>Безопасность</Link>.
    </p>
  );
  const heading = (
    <h2 id="weather-warnings" className="flex items-center gap-2 text-base font-semibold">
      <AlertTriangle size={20} aria-hidden className="text-[var(--warning)]" />
      Предупреждения Росгидромета
    </h2>
  );

  const summary = warnings.kind !== 'failed' ? warningsSummary(warnings.items) : null;
  if (!summary) {
    return (
      <section className={sectionClass} style={sectionStyle} aria-labelledby="weather-warnings">
        {heading}
        {warnings.kind === 'failed' ? (
          <p className={muted}>
            Предупреждения прочитать не удалось. Это не «предупреждений нет» — проверьте их на сайте Гидрометцентра.
          </p>
        ) : (
          <>
            {silentNote}
            <p>{warnings.kind === 'ok' ? 'Действующих предупреждений нет.' : 'Других предупреждений у нас нет, но это не значит, что их нет.'}</p>
          </>
        )}
        {source}
      </section>
    );
  }

  // Свёрнуто (владелец 22.10: «пока до погоды долистать не у всех терпение
  // хватит»): три оранжевых предупреждения занимали экран телефона целиком.
  // Свёрнут текст, не сигнал — сводка в шапке называет число, высший уровень
  // и явления, а цвет кромки остаётся. Красный уровень — «опасно для жизни» —
  // открыт сразу: прятать его за касание платформа безопасности не вправе.
  const items = warnings.kind !== 'failed' ? warnings.items : [];
  return (
    <section className={sectionClass} style={sectionStyle} aria-labelledby="weather-warnings">
      <details className="group" open={summary.highest === 3}>
        <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            {heading}
            <span className={`flex items-center gap-2 text-sm font-medium ${strong}`}>
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: LEVEL_COLOR[summary.highest] }} />
              {summary.line}
            </span>
            <span className={`text-sm ${muted}`}>{summary.phenomena}</span>
            {silentNote}
          </span>
          <span className={`mt-0.5 flex shrink-0 items-center gap-1 text-sm ${muted}`}>
            <span className="group-open:hidden">Подробно</span>
            <span className="hidden group-open:inline">Свернуть</span>
            <ChevronDown size={16} aria-hidden className="transition-transform duration-200 group-open:rotate-180" />
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <ul className="flex flex-col gap-3">
            {items.map((w) => {
              const until = kamchatkaTime(w.until);
              return (
                <li key={`${w.title}|${w.until}`} className="flex flex-col gap-1 border-l-4 pl-3" style={{ borderLeftColor: LEVEL_COLOR[w.severity] }}>
                  <span className="font-semibold">{w.title}</span>
                  {w.text && <span className={`text-sm ${muted}`}>{w.text}</span>}
                  {until && <span className={`text-sm ${faint}`}>Действует до {until} по Камчатке</span>}
                </li>
              );
            })}
          </ul>
          {source}
        </div>
      </details>
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

/* ── Сцена: период и небо — lib/weather/scene (общая с виджетом главной) ── */

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

function SceneHeader({ title }: { title: string }) {
  return (
    <header className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--wx-fg-2)]">Камчатка · прогноз на 7 дней</p>
      <h1 className="text-[1.75rem] font-semibold leading-tight sm:text-4xl" style={{ fontFamily: 'var(--font-playfair)' }}>
        {title}
      </h1>
      <p className="max-w-xl text-sm text-[var(--wx-fg-2)]">
        Прогноз по местам, куда ходят на Камчатке: по дням и по частям дня. Где источник не ответил, так и написано.
      </p>
    </header>
  );
}

/* ── Герой: крупная температура слева, знак погоды справа ─────────────── */

function Hero({ w, today }: { w: OkWeather; today: string }) {
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const nowTemp = w.now?.temp ?? hour?.temp ?? null;
  const apparent = w.now?.apparent ?? hour?.apparent ?? null;
  const description = w.now?.description ?? hour?.description ?? (day ? skyWords(day) : null);
  const code = w.now?.weatherCode ?? hour?.weatherCode ?? day?.weatherCode ?? null;
  const isDay = w.now?.isDay ?? isDayAt(w.now?.time ?? hour?.time, w.days);
  const elevation = elevationLine(w.elevationM);
  const stale = kamchatkaTime(w.staleSince);
  return (
    <section aria-labelledby="weather-now" className="flex flex-col gap-3">
      <h2 id="weather-now" className="sr-only">Сейчас: {w.place.name}</h2>

      {stale && (
        <p className="wx-glass-soft max-w-xl rounded-2xl border-l-2 px-3 py-2 text-sm" style={{ borderLeftColor: 'var(--wx-icon)' }}>
          Источник прогноза сейчас не отвечает. Это последний полученный прогноз — от {stale} по Камчатке.
        </p>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <p className="text-[6rem] font-light leading-[0.9] tracking-tight tabular-nums sm:text-[8.5rem]" aria-label={nowTemp !== null ? `Сейчас ${fmtTemp(nowTemp)} градусов` : undefined}>
            {nowTemp !== null ? `${fmtTemp(nowTemp)}°` : '—'}
          </p>
          <p className="mt-3 text-xl font-medium leading-snug sm:text-2xl">{description ?? 'Условия — нет данных'}</p>
          {day && (day.tempMin !== null || day.tempMax !== null) && (
            <p className="mt-1 tabular-nums text-[var(--wx-fg-2)]" aria-label={`Сегодня ${tempRange(day.tempMin, day.tempMax) ?? 'температура — нет данных'}`}>
              {day.tempMax !== null ? <span aria-hidden>↑{fmtTemp(day.tempMax)}°</span> : null}
              {day.tempMax !== null && day.tempMin !== null ? <span aria-hidden> · </span> : null}
              {day.tempMin !== null ? <span aria-hidden>↓{fmtTemp(day.tempMin)}°</span> : null}
            </p>
          )}
          {day && day.tempMin === null && day.tempMax === null && (
            <p className="mt-1 tabular-nums text-[var(--wx-fg-2)]">Сегодня температура — нет данных</p>
          )}
          {apparent !== null && <p className="text-[var(--wx-fg-2)]">Ощущается как {fmtTemp(apparent)}°</p>}
        </div>
        <ConditionIcon code={code} isDay={isDay} size={112} wx className="mt-2 h-24 w-24 sm:h-36 sm:w-36" />
      </div>

      <div className="flex flex-col gap-0.5 text-sm text-[var(--wx-fg-2)]">
        <p className="flex items-center gap-1.5 font-medium text-[var(--wx-fg)]">
          <MapPin size={15} aria-hidden className="text-[var(--wx-icon)]" />
          {w.place.name}
        </p>
        <p>
          <span className="tabular-nums">{w.lat.toFixed(2)}, {w.lng.toFixed(2)}</span>
          {elevation && <> · <span>{elevation}</span></>}
        </p>
        {w.now?.time && <p>По прогнозу на {hhmm(w.now.time) ?? ''} местного времени</p>}
      </div>
    </section>
  );
}

/* ── Почасовая лента с линией температуры ─────────────────────────────── */

function HourlyCard({ w }: { w: OkWeather }) {
  const start = currentHour(w);
  if (!start) return null;
  const from = Math.max(0, (w.hours ?? []).findIndex((h) => h.time === start.time));
  const hours = (w.hours ?? []).slice(from, from + 24);
  if (hours.length === 0) return null;
  const width = hours.length * HOUR_COL;
  const curve = tempCurve(hours.map((h) => h.temp), { col: HOUR_COL, height: CURVE_H, padTop: 26, padBottom: 10 });
  return (
    <section aria-labelledby="weather-hourly" className="wx-glass flex flex-col gap-2 rounded-[1.75rem] py-3">
      <h2 id="weather-hourly" className="flex items-center gap-2 px-4 text-sm font-medium text-[var(--wx-fg-2)]">
        <Clock size={16} aria-hidden />
        Почасовой прогноз
      </h2>
      <div className="overflow-x-auto" tabIndex={0} aria-label="Почасовой прогноз, прокручивается вбок">
        <div className="min-w-max" style={{ width }}>
          <ol className="flex">
            {hours.map((h, i) => (
              <li key={h.time} className="flex shrink-0 flex-col items-center gap-1.5 text-center" style={{ width: HOUR_COL }}>
                <span className={`text-sm tabular-nums ${i === 0 ? 'font-semibold' : 'text-[var(--wx-fg-2)]'}`}>
                  {i === 0 ? 'Сейчас' : (hhmm(h.time) ?? '')}
                </span>
                <ConditionIcon code={h.weatherCode} isDay={isDayAt(h.time, w.days)} size={24} wx />
                <span className="sr-only">
                  {h.temp !== null ? `${fmtTemp(h.temp)}°` : 'температура — нет данных'}
                  {h.precipProb !== null ? `, осадки ${Math.round(h.precipProb)}%` : ''}
                </span>
              </li>
            ))}
          </ol>
          <div className="relative" style={{ height: CURVE_H }} aria-hidden>
            <svg width={width} height={CURVE_H} viewBox={`0 0 ${width} ${CURVE_H}`} className="absolute inset-0 text-[var(--wx-fg-2)]" focusable="false" data-wx-curve="">
              {curve.path && (
                <path d={curve.path} fill="none" stroke="currentColor" strokeOpacity="0.7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              )}
              {curve.points.map((p, i) => (p ? (
                <circle key={hours[i].time} cx={p.x} cy={p.y} r={i === 0 ? 4.5 : 3} fill={i === 0 ? 'var(--wx-fg)' : 'currentColor'} />
              ) : null))}
            </svg>
            {curve.points.map((p, i) => (p ? (
              <span
                key={hours[i].time}
                className={`absolute -translate-x-1/2 text-sm tabular-nums ${i === 0 ? 'font-semibold' : ''}`}
                style={{ left: p.x, top: Math.max(0, p.y - 24) }}
              >
                {fmtTemp(p.temp)}°
              </span>
            ) : (
              <span key={hours[i].time} className="absolute top-1 -translate-x-1/2 text-sm text-[var(--wx-fg-3)]" style={{ left: i * HOUR_COL + HOUR_COL / 2 }}>—</span>
            )))}
          </div>
          <ol className="flex" aria-hidden>
            {hours.map((h) => (
              <li key={h.time} className="flex shrink-0 flex-col items-center gap-0.5 text-center" style={{ width: HOUR_COL }}>
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
      </div>
    </section>
  );
}

/* ── Неделя: строки «день · осадки · знак · макс/мин» ─────────────────── */

/** «Сегодня»/«Завтра»/«Пт» сверху и «24 окт.» снизу. */
function dayTitle(date: string, today: string): { top: string; bottom: string } {
  const label = dayLabel(date, today);
  const d = new Date(`${date}T12:00:00Z`);
  const bottom = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (label === 'Сегодня' || label === 'Завтра') return { top: label, bottom };
  const wd = d.toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });
  return { top: wd.charAt(0).toUpperCase() + wd.slice(1), bottom };
}

function DayParts({ parts }: { parts: NonNullable<ForecastDay['parts']> }) {
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
      {parts.map((p) => (
        <div key={p.label} className="wx-glass-soft flex flex-col gap-0.5 rounded-2xl p-2.5">
          <dt className="ds-label">{p.label}</dt>
          <dd className="text-sm tabular-nums">{tempRange(p.tempMin, p.tempMax) ?? 'нет данных'}</dd>
          <dd className="text-sm text-[var(--wx-fg-2)]">{partPrecip(p)}</dd>
          <dd className="text-xs text-[var(--wx-fg-3)]">{windLine(p.windKmh)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Строка дня: одна кнопка-раскрытие, как в погодных приложениях — нажал на
 * день, открылись части дня. Внутри summary допустимы только строчные
 * элементы, поэтому вёрстка на span с display-классами.
 */
function DayRow({ d, today }: { d: ForecastDay; today: string }) {
  const title = dayTitle(d.date, today);
  const prob = d.precipProbMax ?? null;
  // Части подробностей не рвутся внутри: «м/с» браузер иначе переносит по косой черте.
  const details = [skyWords(d), precipLine(d.precipMm), windLine(d.windKmh)].filter((s): s is string => Boolean(s));
  const parts = d.parts ?? [];
  const row = (
    <>
      <span className="flex items-center gap-3">
        <span className="flex w-24 shrink-0 flex-col leading-tight sm:w-32">
          <span className="font-semibold">{title.top}</span>
          <span className="text-xs text-[var(--wx-fg-3)]">{title.bottom}</span>
        </span>
        <span className="flex w-12 shrink-0 items-center gap-1 text-sm tabular-nums text-[var(--wx-icon)]" aria-hidden>
          <Droplets size={14} aria-hidden />
          {prob !== null ? `${Math.round(prob)}%` : '—'}
        </span>
        <ConditionIcon code={d.weatherCode} size={26} wx />
        <span className="ml-auto flex items-baseline gap-3 tabular-nums" aria-hidden>
          <span className="text-lg font-semibold">{d.tempMax !== null ? `${fmtTemp(d.tempMax)}°` : '—'}</span>
          <span className="text-[var(--wx-fg-2)]">{d.tempMin !== null ? `${fmtTemp(d.tempMin)}°` : '—'}</span>
        </span>
      </span>
      <span className="sr-only">
        {tempRange(d.tempMin, d.tempMax) ?? 'температура — нет данных'}
        {prob !== null ? `, вероятность осадков ${Math.round(prob)}%` : ''}
      </span>
      <span className="mt-0.5 block text-sm text-[var(--wx-fg-2)]">
        {details.map((s, i) => (
          <span key={s}>
            {i > 0 ? ' · ' : ''}
            <span className="whitespace-nowrap">{s}</span>
          </span>
        ))}
      </span>
    </>
  );
  if (parts.length === 0) return <div className="py-2.5">{row}</div>;
  return (
    <details className="group py-2.5">
      <summary className="block cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {row}
        <span className="mt-1 inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-[var(--wx-icon)]">
          По частям дня
          <ChevronDown size={14} aria-hidden className="transition-transform duration-200 group-open:rotate-180" />
        </span>
      </summary>
      <DayParts parts={parts} />
    </details>
  );
}

function WeekCard({ w, today }: { w: OkWeather; today: string }) {
  return (
    <section aria-labelledby="weather-week" className="wx-glass flex flex-col rounded-[1.75rem] px-4 pb-2 pt-3">
      <h2 id="weather-week" className="flex items-center gap-2 text-sm font-medium text-[var(--wx-fg-2)]">
        <CalendarDays size={16} aria-hidden />
        Прогноз на 7 дней
      </h2>
      <ol className="mt-1 flex flex-col divide-y divide-[var(--wx-glass-border)]">
        {w.days.map((d) => (
          <li key={d.date}>
            <DayRow d={d} today={today} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ── Плитки-приборы ───────────────────────────────────────────────────── */

function Tile({ icon, label, wide = false, children }: { icon: ReactNode; label: string; wide?: boolean; children: ReactNode }) {
  return (
    <li className={`wx-glass flex min-h-[132px] flex-col gap-2 rounded-[1.5rem] p-4 ${wide ? 'col-span-2' : ''}`}>
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--wx-fg-2)]">{icon}{label}</span>
      {children}
    </li>
  );
}

/** Показание прибора: крупное число, единица — мельче рядом, чтобы не ломать строку в узкой плитке. */
function Value({ children, unit }: { children: ReactNode; unit?: string }) {
  return (
    <span className="text-2xl font-light leading-tight tabular-nums">
      {children}
      {unit ? <span className="text-base font-normal text-[var(--wx-fg-2)]"> {unit}</span> : null}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <span className="text-sm text-[var(--wx-fg-3)]">{children}</span>;
}

/** Компас: стороны света по кругу, стрелка летит по ветру. */
function WindCompass({ rotation }: { rotation: number | null }) {
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20 shrink-0" aria-hidden focusable="false">
      <circle cx="40" cy="40" r="26" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
      <text x="40" y="10" textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.75">С</text>
      <text x="73" y="43" textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.75">В</text>
      <text x="40" y="77" textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.75">Ю</text>
      <text x="7" y="43" textAnchor="middle" fontSize="9" fill="currentColor" fillOpacity="0.75">З</text>
      {rotation !== null && (
        <g transform={`rotate(${rotation} 40 40)`} className="text-[var(--wx-icon)]">
          <path d="M40 16 L46 30 L40 26.5 L34 30 Z" fill="currentColor" />
          <line x1="40" y1="27" x2="40" y2="62" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

function Ring({ percent }: { percent: number }) {
  const { filled, circumference } = ringDash(percent, 24);
  return (
    <svg viewBox="0 0 60 60" className="h-16 w-16 shrink-0 -rotate-90" aria-hidden focusable="false">
      <circle cx="30" cy="30" r="24" fill="none" stroke="var(--wx-track)" strokeWidth="6" />
      <circle cx="30" cy="30" r="24" fill="none" stroke="var(--wx-icon)" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${filled} ${circumference}`} />
    </svg>
  );
}

function UvScale({ uv }: { uv: number }) {
  const pct = uvMarkerPercent(uv);
  if (pct === null) return null;
  return (
    <span
      className="relative mt-auto block h-1.5 w-full rounded-full"
      style={{ background: 'linear-gradient(90deg, var(--success), var(--warning), var(--danger), var(--purple))' }}
      aria-hidden
    >
      <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--wx-glass-border)] bg-[var(--wx-fg)]" style={{ left: `${pct}%` }} />
    </span>
  );
}

const ARC_FROM = { x: 12, y: 56 };
const ARC_PEAK = { x: 120, y: -16 };
const ARC_TO = { x: 228, y: 56 };

/** Дуга дня: пунктир от восхода к закату, солнце — по доле прошедшего дня. */
function SunArc({ sunrise, sunset, now }: { sunrise: string | null; sunset: string | null; now: string | null }) {
  const t = daylightFraction(sunrise, sunset, now);
  const sun = t === null ? null : arcPoint(t, ARC_FROM, ARC_PEAK, ARC_TO);
  return (
    <svg viewBox="0 0 240 64" className="h-16 w-full" preserveAspectRatio="xMidYMid meet" aria-hidden focusable="false" data-sun={sun ? 'up' : 'down'}>
      <line x1="0" y1="56" x2="240" y2="56" stroke="currentColor" strokeOpacity="0.3" />
      <path d={`M${ARC_FROM.x} ${ARC_FROM.y} Q${ARC_PEAK.x} ${ARC_PEAK.y} ${ARC_TO.x} ${ARC_TO.y}`} fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="4 5" />
      {sun && <circle cx={sun.x} cy={sun.y} r="7" fill="var(--wx-sun)" />}
    </svg>
  );
}

function DetailGrid({ w, today }: { w: OkWeather; today: string }) {
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const tiles: ReactNode[] = [];

  const apparent = w.now?.apparent ?? hour?.apparent ?? null;
  const airTemp = w.now?.temp ?? hour?.temp ?? null;
  if (apparent !== null) {
    tiles.push(
      <Tile key="apparent" icon={<Thermometer size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Ощущается как">
        <Value>{fmtTemp(apparent)}°</Value>
        {airTemp !== null && <Hint>при температуре воздуха {fmtTemp(airTemp)}°</Hint>}
      </Tile>,
    );
  }

  const windKmh = w.now?.windKmh ?? hour?.windKmh ?? null;
  const gustKmh = w.now?.windGustKmh ?? hour?.windGustKmh ?? null;
  const windDir = w.now?.windDirDeg ?? hour?.windDirDeg ?? null;
  const dirWords = windDirectionWords(windDir);
  if (windKmh !== null || gustKmh !== null) {
    tiles.push(
      <Tile key="wind" icon={<Wind size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Ветер">
        <span className="flex items-center gap-2">
          <WindCompass rotation={windArrowRotation(windDir)} />
          {windKmh !== null && <Value unit="м/с">{Math.round(windKmh / 3.6)}</Value>}
        </span>
        {gustKmh !== null && <Hint>порывы {Math.round(gustKmh / 3.6)} м/с</Hint>}
        {dirWords && <Hint>{dirWords}</Hint>}
      </Tile>,
    );
  } else if (dirWords) {
    tiles.push(
      <Tile key="wind-dir" icon={<Compass size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Направление ветра">
        <WindCompass rotation={windArrowRotation(windDir)} />
        <span className="text-base">{dirWords}</span>
      </Tile>,
    );
  }

  const humidity = w.now?.humidity ?? hour?.humidity ?? null;
  if (humidity !== null) {
    tiles.push(
      <Tile key="humidity" icon={<Droplets size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Влажность">
        <span className="flex items-center gap-3">
          <Ring percent={humidity} />
          <Value>{Math.round(humidity)}%</Value>
        </span>
      </Tile>,
    );
  }

  const uv = day?.uvIndexMax ?? hour?.uvIndex ?? null;
  if (uv !== null && uv !== undefined) {
    tiles.push(
      <Tile key="uv" icon={<Sun size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="УФ-индекс">
        <Value>{uvWords(uv)}</Value>
        {day?.uvIndexMax ? <Hint>максимум за день</Hint> : null}
        <UvScale uv={uv} />
      </Tile>,
    );
  }

  const sunrise = hhmm(day?.sunrise);
  const sunset = hhmm(day?.sunset);
  if (sunrise || sunset) {
    const nowHm = hhmm(w.now?.time ?? hour?.time);
    const below = sunrise && sunset && nowHm && daylightFraction(sunrise, sunset, nowHm) === null;
    tiles.push(
      <Tile key="sun" wide icon={<Sunrise size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Восход и закат">
        <SunArc sunrise={sunrise} sunset={sunset} now={nowHm} />
        <span className="flex items-baseline justify-between gap-3 tabular-nums">
          <span>{sunrise ? `Восход ${sunrise}` : 'Восход — нет данных'}</span>
          <span>{sunset ? `Закат ${sunset}` : 'Закат — нет данных'}</span>
        </span>
        {below ? <Hint>Солнце за горизонтом</Hint> : null}
      </Tile>,
    );
  }

  if (day) {
    const mm = day.precipMm;
    tiles.push(
      <Tile key="precip" icon={<Umbrella size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Осадки сегодня">
        {mm === null ? <Value>нет данных</Value> : mm < PRECIP_DRY_MM ? <Value>без осадков</Value> : <Value unit="мм">{fmtNumber(mm)}</Value>}
        {day.precipProbMax !== null && day.precipProbMax !== undefined ? <Hint>вероятность до {Math.round(day.precipProbMax)}%</Hint> : null}
      </Tile>,
    );
  }

  // Оба поля — pressure_msl (приведённое к уровню моря); surface_pressure сюда не попадает, при отсутствии приведённого плитки нет.
  const pressure = pressureMm(w.now?.pressureHpa ?? hour?.pressureHpa ?? null);
  if (pressure !== null) {
    tiles.push(
      <Tile key="pressure" icon={<Gauge size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Давление">
        <Value unit="мм рт. ст.">{pressure}</Value>
        <Hint>к уровню моря</Hint>
      </Tile>,
    );
  }

  if (hour?.visibilityM !== null && hour?.visibilityM !== undefined) {
    tiles.push(
      <Tile key="visibility" icon={<Eye size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Видимость">
        <Value>{visibilityLine(hour.visibilityM)}</Value>
      </Tile>,
    );
  }

  if (hour?.cloudCover !== null && hour?.cloudCover !== undefined) {
    const cover = Math.max(0, Math.min(100, hour.cloudCover));
    tiles.push(
      <Tile key="cloud" icon={<Cloud size={15} aria-hidden className="text-[var(--wx-icon)]" />} label="Облачность">
        <Value>{Math.round(cover)}%</Value>
        <span className="relative mt-auto block h-1.5 w-full overflow-hidden rounded-full bg-[var(--wx-track)]" aria-hidden>
          <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--wx-icon)]" style={{ width: `${cover}%` }} />
        </span>
      </Tile>,
    );
  }

  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby="weather-details" className="flex flex-col gap-2">
      <h2 id="weather-details" className="px-1 text-sm font-medium text-[var(--wx-fg-2)]">Сейчас в деталях</h2>
      <ul className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">{tiles}</ul>
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
  const title = isDefault ? 'Погода на Камчатке' : `Погода ${place.where}`;
  const selected = data.selected;
  const scene = selected.kind === 'ok' ? weatherScene(selected, data.today) : null;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:gap-6">
      {selected.kind === 'ok' ? (
        <div
          className="wx-scene flex flex-col gap-4 px-4 py-5 sm:gap-5 sm:p-6"
          data-wx-scene={scene?.name}
          data-wx-period={scene?.period}
          data-wx-sky={scene?.sky}
        >
          <SceneSilhouette />
          <SceneHeader title={title} />
          <Hero w={selected} today={data.today} />
          <Warnings warnings={data.warnings} scene />
          <PlaceSwitcher current={place.slug} scene />
          <HourlyCard w={selected} />
          <WeekCard w={selected} today={data.today} />
          <DetailGrid w={selected} today={data.today} />
        </div>
      ) : (
        <>
          <header className="flex flex-col gap-2">
            <p className="ds-label">Камчатка · прогноз на 7 дней</p>
            <h1 className="ds-h1" style={{ fontFamily: 'var(--font-playfair)' }}>{title}</h1>
            <p className="max-w-xl text-[var(--text-secondary)]">
              Прогноз по местам, куда ходят на Камчатке: по дням и по частям дня. Где источник не ответил, так и написано.
            </p>
          </header>
          <Warnings warnings={data.warnings} />
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
