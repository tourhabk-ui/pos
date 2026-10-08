import Link from 'next/link';
import { AlertTriangle, CloudSun, MapPin, Phone } from 'lucide-react';
import type { ForecastDay } from '@/lib/planner/intelligence';
import { METEOALERT_PAGE } from '@/lib/services/safety/meteoalert';
import {
  DEFAULT_WEATHER_SLUG, WEATHER_GROUP_LABELS, WEATHER_PLACES, weatherPlaceHref, type WeatherPlaceGroup,
} from '@/lib/weather/places';
import type { MeteoWarningItem, PlaceWeather, WarningsRead, WeatherPageData } from '@/lib/weather/weather-page';
import {
  dayLabel, elevationLine, fmtNumber, kamchatkaTime, partPrecip, precipLine, skyWords, tempRange, windLine,
} from '@/lib/weather/weather-format';
import { PRECIP_DRY_MM } from '@/lib/weather/day-parts';

/**
 * Страница погоды: предупреждения Росгидромета, места, прогноз выбранного
 * места на неделю, все места на сегодня и завтра, откуда прогноз. Серверный
 * рендер без скриптов: места переключаются ссылками, страница работает и
 * там, где скрипты не догрузились.
 */

/** Цвет уровня Росгидромета: жёлтый — внимание, оранжевый — высокий, красный — опасность. */
const LEVEL_COLOR: Record<MeteoWarningItem['severity'], string> = {
  1: 'var(--warning)',
  2: 'var(--accent)',
  3: 'var(--danger)',
};

const GROUPS: WeatherPlaceGroup[] = ['city', 'trail', 'settlement'];

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function Warnings({ warnings }: { warnings: WarningsRead }) {
  const checked = warnings.kind !== 'failed' ? kamchatkaTime(warnings.checkedAt) : null;
  return (
    <section className="ds-section flex flex-col gap-3" aria-labelledby="weather-warnings">
      <h2 id="weather-warnings" className="ds-h2 flex items-center gap-2">
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

function PlaceSwitcher({ current }: { current: string }) {
  return (
    <nav aria-label="Места" className="flex flex-col gap-3">
      {GROUPS.map((g) => (
        <div key={g} className="flex flex-col gap-2">
          <span className="ds-label">{WEATHER_GROUP_LABELS[g]}</span>
          <ul className="flex flex-wrap gap-2">
            {WEATHER_PLACES.filter((p) => p.group === g).map((p) => {
              const active = p.slug === current;
              return (
                <li key={p.slug}>
                  <Link
                    href={weatherPlaceHref(p)}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex min-h-[44px] items-center rounded-full border px-4 text-sm no-underline transition-colors duration-200 ${
                      active
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

function DayRow({ d, today }: { d: ForecastDay; today: string }) {
  const parts = d.parts ?? [];
  const sky = skyWords(d);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="w-32 shrink-0 font-semibold">{dayLabel(d.date, today)}</span>
        <span className="text-xl font-bold tabular-nums" style={{ fontFamily: 'var(--font-playfair)' }}>
          {tempRange(d.tempMin, d.tempMax) ?? 'температура — нет данных'}
        </span>
        <span className="text-[var(--text-secondary)]">
          {precipLine(d.precipMm)} · {windLine(d.windKmh)}{sky ? ` · ${sky.toLowerCase()}` : ''}
        </span>
      </div>
      {parts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {parts.map((p) => (
            <div key={p.label} className="flex flex-col gap-0.5 border-l border-[var(--border-strong)] pl-3">
              <dt className="ds-label">{p.label}</dt>
              <dd className="text-sm tabular-nums">{tempRange(p.tempMin, p.tempMax) ?? 'нет данных'}</dd>
              <dd className="text-sm text-[var(--text-secondary)]">{partPrecip(p)}</dd>
              <dd className="text-xs text-[var(--text-muted)]">{windLine(p.windKmh)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function PlaceForecast({ w, today }: { w: PlaceWeather; today: string }) {
  const elevation = w.kind === 'ok' ? elevationLine(w.elevationM) : null;
  const stale = w.kind === 'ok' ? kamchatkaTime(w.staleSince) : null;
  return (
    <section className="ds-section flex flex-col gap-4" aria-labelledby="weather-place">
      <div className="flex flex-col gap-1">
        <h2 id="weather-place" className="ds-h2 flex items-center gap-2">
          <MapPin size={20} aria-hidden className="text-[var(--ocean)]" />
          {w.place.name}
        </h2>
        {w.kind === 'ok' && (
          <p className="text-sm text-[var(--text-secondary)]">
            <span className="tabular-nums">{w.lat.toFixed(2)}, {w.lng.toFixed(2)}</span>
            {elevation ? ` · ${elevation}` : ''}
          </p>
        )}
      </div>
      {w.kind === 'missing' && (
        <p className="text-[var(--text-secondary)]">Этого места нет в справочнике платформы — прогноз именно для него дать не можем.</p>
      )}
      {w.kind === 'failed' && (
        <p className="text-[var(--text-secondary)]">Прогноз не получили ({w.reason}). Попробуйте позже; погоду по памяти не называем.</p>
      )}
      {w.kind === 'ok' && (
        <>
          {stale && (
            <p className="border-l-2 border-[var(--warning)] pl-3 text-sm">
              Источник прогноза сейчас не отвечает. Это последний полученный прогноз — от {stale} по Камчатке.
            </p>
          )}
          <ol className="flex flex-col divide-y divide-[var(--border)]">
            {w.days.map((d) => <DayRow key={d.date} d={d} today={today} />)}
          </ol>
        </>
      )}
    </section>
  );
}

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
    <section className="ds-section flex flex-col gap-3" aria-labelledby="weather-all">
      <h2 id="weather-all" className="ds-h2 flex items-center gap-2">
        <CloudSun size={20} aria-hidden className="text-[var(--ocean)]" />
        Все места: сегодня и завтра
      </h2>
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {all.map((w) => (
          <li key={w.place.slug}>
            <Link
              href={weatherPlaceHref(w.place)}
              aria-current={w.place.slug === current ? 'page' : undefined}
              className="-mx-2 flex min-h-[44px] flex-col gap-1 rounded-lg px-2 py-3 no-underline transition-colors duration-200 hover:bg-[var(--bg-hover)] sm:flex-row sm:items-baseline sm:gap-4"
            >
              <span className="flex shrink-0 flex-col sm:w-52">
                <span className="font-semibold text-[var(--text-primary)]">{w.place.name}</span>
                {/* Горная точка без высоты читается погодой подножия: Авачинский
                    −17° — это вершина на 2710 м, а не лагерь. Порог — тот же,
                    что у предупреждения «ниже теплее» (elevationNote). */}
                {w.kind === 'ok' && w.elevationM !== null && w.elevationM >= 500 && (
                  <span className="text-xs text-[var(--text-muted)]">точка на ~{Math.round(w.elevationM / 10) * 10} м</span>
                )}
              </span>
              {w.kind === 'ok' ? (
                <span className="flex flex-col gap-0.5 text-sm text-[var(--text-secondary)] tabular-nums">
                  <span>Сегодня {shortDay(w.days.find((d) => d.date === today))}</span>
                  <span>Завтра {shortDay(w.days.find((d) => d.date === tomorrow))}</span>
                </span>
              ) : (
                <span className="text-sm text-[var(--text-secondary)]">
                  {w.kind === 'missing' ? 'места нет в справочнике' : 'прогноз не получили'}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
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
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-3">
        <p className="ds-label">Камчатка · прогноз на 7 дней</p>
        <h1 className="ds-h1" style={{ fontFamily: 'var(--font-playfair)' }}>
          {isDefault ? 'Погода на Камчатке' : `Погода ${place.where}`}
        </h1>
        <p className="max-w-xl text-[var(--text-secondary)]">
          Прогноз по местам, куда ходят на Камчатке: по дням и по частям дня. Где источник не ответил, так и написано.
        </p>
      </header>

      <Warnings warnings={data.warnings} />
      <PlaceSwitcher current={place.slug} />
      <PlaceForecast w={data.selected} today={data.today} />
      <Overview all={data.all} today={data.today} current={place.slug} />
      <SourceNote w={data.selected} />

      <p className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Phone size={16} aria-hidden />
        Экстренный телефон 112. В беде на маршруте — кнопка SOS в шапке.
      </p>
    </div>
  );
}
