/**
 * Сводка дня для гидов и операторов — `/svodka`.
 *
 * Решение владельца 30.09: входить в индустрию не с «разместитесь у нас», а с
 * пользой, которую операторам не даёт никто, — утренней обстановкой по их
 * маршрутам. Владелец открывает страницу, копирует текст и рассылает сам;
 * автоматической рассылки чужим людям здесь нет (их номера и согласие — отдельный
 * шаг, 152-ФЗ).
 *
 * ── Источник один с Кузьмичом ──────────────────────────────────────────────
 *
 * Сводка не считает ничего своего. Обстановка — `getCurrentSafetyStatus` (то
 * же, что MCP `safety_status` и плитка главной), вулканы — `elevatedVolcanoes`
 * (тот же отбор и порядок, что `get_volcano_status`), погода —
 * `fetchForecastDays` и `resolvePlaceCoords` (как `get_weather`). Иначе
 * оператор прочёл бы утром одно, а турист спросил бы Кузьмича и услышал другое.
 *
 * ── Третий исход (§4.0) ────────────────────────────────────────────────────
 *
 * Источник не ответил — строка говорит «не удалось получить», а не молчит и не
 * пишет «всё спокойно». Для гида в поле разница между «тревог нет» и «мы не
 * знаем» — это решение, выходить ли группе.
 */

import { getCurrentSafetyStatus, type CurrentSafetyStatus } from '@/lib/safety/current-status';
import { elevatedVolcanoes, loadVolcanoInput, type MergedVolcano } from '@/lib/kuzmich/volcano-tool';
import { DEFAULT_WEATHER_PLACE, resolvePlaceCoords } from '@/lib/kuzmich/weather-tool';
import { fetchForecastDays, type ForecastDay } from '@/lib/planner/intelligence';
import { ACC_META, type AccColor } from '@/lib/services/safety/kvert-vona';
import { scaleColorWord } from '@/lib/services/safety/volcano-scales';

/** Точки погоды: город и три места, куда ходят чаще всего. Имена — как в каталоге. */
export const SVODKA_WEATHER_PLACES = ['Авачинский', 'Мутновский', 'Эссо'] as const;
const WEATHER_DAYS = 2;
const VOLCANO_LIMIT = 8;
const ALERTS_LIMIT = 8;

export interface VolcanoLine {
  name: string;
  /** Пепел по KVERT словом («оранжевый»), null — кода нет. */
  ash: string | null;
  ashKm: number | null;
  /** Сейсмичность по КФ ЕГС словом, null — вулкан не в сводке или сводка не свежая. */
  tremor: string | null;
  /** Цвет строки: самый тревожный из двух. */
  level: 'red' | 'orange' | 'yellow';
}

export interface WeatherLine {
  name: string;
  /** null — прогноз не получили; `reason` говорит почему. */
  days: ForecastDay[] | null;
  reason: string | null;
}

export interface Svodka {
  /** Дата сводки по Камчатке, «30 сентября». */
  dateLabel: string;
  generatedAt: string;
  /** null — обстановку прочитать не смогли (это не «тревог нет»). */
  safety: CurrentSafetyStatus | null;
  volcanoes: { sources: string; complete: boolean; items: VolcanoLine[]; more: number } | null;
  weather: WeatherLine[];
}

const RANK: Record<string, number> = { red: 3, orange: 2, yellow: 1 };

function kvertWord(acc: string | undefined): string | null {
  if (!acc) return null;
  const meta = (ACC_META as Record<string, { short: string } | undefined>)[acc as AccColor];
  return acc === 'unassigned' || !meta ? null : meta.short.toLowerCase();
}

function toLine(m: MergedVolcano): VolcanoLine {
  const a = m.kvert?.acc ?? null;
  const t = m.kfegs?.color ?? null;
  const top = [a, t].filter((c): c is string => !!c && c in RANK).sort((x, y) => RANK[y] - RANK[x])[0];
  return {
    name: m.name,
    ash: kvertWord(a ?? undefined),
    ashKm: m.kvert?.ash_height_m ? Math.round(m.kvert.ash_height_m / 100) / 10 : null,
    tremor: scaleColorWord(t),
    level: (top ?? 'yellow') as VolcanoLine['level'],
  };
}

async function loadVolcanoes(nowMs: number): Promise<Svodka['volcanoes']> {
  try {
    const v = elevatedVolcanoes(await loadVolcanoInput(), nowMs);
    return {
      sources: v.sources,
      complete: v.complete,
      items: v.items.slice(0, VOLCANO_LIMIT).map(toLine),
      more: Math.max(0, v.items.length - VOLCANO_LIMIT),
    };
  } catch (err) {
    console.error('[svodka] вулканы не прочитаны:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function loadWeather(): Promise<WeatherLine[]> {
  const points: Array<{ name: string; lat: number; lng: number } | { name: string; missing: true }> = [
    { name: 'Петропавловск-Камчатский', lat: DEFAULT_WEATHER_PLACE.lat, lng: DEFAULT_WEATHER_PLACE.lng },
  ];
  for (const name of SVODKA_WEATHER_PLACES) {
    try {
      const p = await resolvePlaceCoords(name);
      // Подпись — та, что мы спросили, а не имя найденной записи: поиск по
      // «Эссо» находит «Вид на Эссо» (смотровая у села), и строка «Вид на
      // Эссо: −3°» читается как погода на смотровой, а не в селе.
      points.push(p ? { name, lat: p.lat, lng: p.lng } : { name, missing: true });
    } catch (err) {
      console.error(`[svodka] координаты «${name}» не прочитаны:`, err instanceof Error ? err.message : err);
      points.push({ name, missing: true });
    }
  }
  return Promise.all(points.map(async (p): Promise<WeatherLine> => {
    if ('missing' in p) return { name: p.name, days: null, reason: 'места нет в каталоге' };
    const f = await fetchForecastDays(p.lat, p.lng, WEATHER_DAYS);
    return f.ok ? { name: p.name, days: f.days, reason: null } : { name: p.name, days: null, reason: f.reason };
  }));
}

/** Собрать сводку. Каждый источник — своим путём: отказ одного не гасит остальные. */
export async function loadSvodka(now: Date = new Date()): Promise<Svodka> {
  const [safety, volcanoes, weather] = await Promise.all([
    getCurrentSafetyStatus().catch((err: unknown) => {
      console.error('[svodka] обстановка не прочитана:', err instanceof Error ? err.message : err);
      return null;
    }),
    loadVolcanoes(now.getTime()),
    loadWeather(),
  ]);
  return {
    dateLabel: now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Kamchatka' }),
    generatedAt: now.toISOString(),
    safety,
    volcanoes,
    weather,
  };
}

/** «−11…−10°, снег 30 мм, ветер до 18 км/ч» — без пустых кусков. */
export function weatherPhrase(d: ForecastDay): string {
  const parts: string[] = [];
  if (d.tempMin != null && d.tempMax != null) {
    const r = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(Math.round(n))}`;
    parts.push(`${r(d.tempMin)}…${r(d.tempMax)}°`);
  }
  if (d.description) parts.push(d.description.toLowerCase());
  if (d.precipMm != null && d.precipMm >= 1) parts.push(`осадки ${Math.round(d.precipMm)} мм`);
  if (d.windKmh != null) parts.push(`ветер до ${Math.round(d.windKmh)} км/ч`);
  return parts.join(', ') || 'нет данных';
}

export function volcanoPhrase(v: VolcanoLine): string {
  const ash = v.ash ? `пепел ${v.ash}${v.ashKm ? `, до ${v.ashKm} км` : ''}` : 'пепел: кода нет';
  const tremor = v.tremor ? `сейсмичность ${v.tremor}` : 'сейсмичность: нет в сводке';
  return `${v.name}: ${ash}; ${tremor}`;
}

function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/** Текст для WhatsApp и Telegram: без разметки, короткими строками. */
export function svodkaText(s: Svodka, siteUrl = 'https://vedarai.ru'): string {
  const out: string[] = [`Сводка Ведара для гидов · ${s.dateLabel}`, ''];

  out.push('Что меняет планы:');
  if (!s.safety) {
    out.push('— обстановку получить не удалось, проверьте МЧС напрямую');
  } else if (s.safety.feedTitles === null) {
    out.push('— список предупреждений получить не удалось');
  } else if (s.safety.feedTitles.length === 0) {
    out.push('— предупреждений, меняющих планы, нет');
  } else {
    for (const t of s.safety.feedTitles.slice(0, ALERTS_LIMIT)) out.push(`— ${t}`);
    const rest = (s.safety.feedCount ?? 0) - Math.min(s.safety.feedTitles.length, ALERTS_LIMIT);
    if (rest > 0) out.push(`— и ещё ${rest}`);
  }

  out.push('', 'Вулканы выше фона (KVERT, КФ ЕГС):');
  if (!s.volcanoes) {
    out.push('— сводки вулканов получить не удалось');
  } else if (s.volcanoes.items.length === 0) {
    out.push(s.volcanoes.complete ? '— повышенной активности нет' : '— по доступным данным повышенных нет, но не все источники проверены');
  } else {
    for (const v of s.volcanoes.items) out.push(`— ${volcanoPhrase(v)}`);
    if (s.volcanoes.more > 0) out.push(`— и ещё ${s.volcanoes.more}`);
  }

  out.push('', 'Погода (Open-Meteo):');
  for (const w of s.weather) {
    if (!w.days || w.days.length === 0) { out.push(`— ${w.name}: прогноз не получили`); continue; }
    out.push(`— ${w.name}: ${w.days.map((d) => `${dayLabel(d.date)} ${weatherPhrase(d)}`).join('; ')}`);
  }

  out.push('', 'Коды вулканов — об активности, а не разрешение на выход. Экстренный телефон 112.');
  out.push(`Подробнее: ${siteUrl}/svodka`);
  return out.join('\n');
}
