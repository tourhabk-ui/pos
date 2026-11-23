/**
 * Карточка дня — только программа (слово владельца 21.11: «предупреждения —
 * это п***ц, кроме них ничего не видно»).
 *
 * В карточке дня: название, ссылка на тур, одна короткая строка погоды
 * («−18…−9 °C, пасмурно») и не больше ОДНОЙ короткой строки-предупреждения —
 * только если она называет место из программы этого дня. Всё остальное
 * (сводки МЧС и Турпортала, разрешения, медведи, связь, путёвки, совет по
 * одежде) — один раз, без повторов, в свёрнутом блоке «Безопасность и
 * разрешения» под планом (`safetyBlock`). Ничего не теряется: что снято с
 * дня, стоит в блоке с номерами дней.
 *
 * Многодневный тур (дни 1–5 «Камчатка: термальный маршрут») — одним блоком
 * «Дни 1–5» с одной карточкой (`tourRuns`).
 */
import { KIT_ITEMS } from '@/lib/planner/weather-kit';

export interface ViewDay {
  day: number;
  /** Нет поля — поездка, сохранённая до рода дня: считается занятием. */
  type?: string;
  title: string;
  description?: string;
  dayWarnings?: readonly string[];
  weatherKit?: string;
  weatherForecast?: { tempMax: number; tempMin: number; description: string } | null;
  realTour?: { tourId?: string; title?: string } | null;
}

export interface PlanWarningLike { type: string; severity: string; message: string }

/** Типы предупреждений плана, что остаются над днями: они про сам план. */
export const PLAN_SHAPE_TYPES: ReadonlySet<string> = new Set(['duration', 'dates', 'tour_dates', 'home_nights', 'season', 'zone_days', 'children']);

export const SAFETY_BLOCK_TITLE = 'Безопасность и разрешения';
export const DAY_WARNING_MAX = 140;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Ключ блока безопасности: пунктуация и лишние пробелы не делают вторую строку. */
const safetyKey = (s: string) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Слова-места (с заглавной, от 4 букв) — без служебных: кто сообщил и т. п. */
const NOT_PLACES = new Set([
  'мчс', 'турпортал', 'сводка', 'сводки', 'источник', 'камчатка', 'камчатки', 'края', 'кбгс', 'ран',
  'только', 'возьмите', 'прогноз', 'резерв', 'если', 'перед', 'обязательно', 'нужна', 'нужно', 'рекомендуем',
  'медведи', 'внимание', 'связи', 'связь', 'путевка', 'разрешение', 'день', 'тура', 'туры',
]);

function placeStems(warning: string): string[] {
  const out = new Set<string>();
  // Без lookbehind: модуль идёт в клиентский бандл (Safari < 16.4).
  for (const m of warning.matchAll(/(?:^|[^\p{L}])(\p{Lu}[\p{Ll}-]{3,})/gu)) {
    const w = norm(m[1]);
    if (NOT_PLACES.has(w)) continue;
    out.add(w.slice(0, Math.max(4, w.length - 2)));
  }
  return [...out];
}

function programText(d: ViewDay): string {
  return norm(`${d.title} ${d.realTour?.title ?? ''}`);
}

/** Первая фраза, не длиннее DAY_WARNING_MAX. */
export function shortLine(text: string): string {
  const end = /[.!?](\s|$)/.exec(text);
  const first = end ? text.slice(0, end.index + 1) : text;
  return first.length <= DAY_WARNING_MAX ? first : `${first.slice(0, DAY_WARNING_MAX - 1).trimEnd()}…`;
}

/**
 * Одна строка-предупреждение дня или null: только та, что называет место из
 * программы дня (название дня или тура), без истёкших сводок.
 */
export function dayCardWarning(d: ViewDay): string | null {
  const program = programText(d);
  const list = d.dayWarnings ?? [];
  // Закрытие парка движок ставит по ссылке самого места дня (тревоги парков
  // по местам плана) — это и есть строка о месте программы, она первая.
  const park = list.find((w) => /^Закрытие парка/.test(w));
  if (park) return shortLine(park);
  for (const w of list) {
    if (/срок истёк|срок истек/.test(w)) continue;
    if (placeStems(w).some((stem) => program.includes(stem))) return shortLine(w);
  }
  return null;
}

const signed = (n: number) => {
  const r = Math.round(n);
  return r < 0 ? `−${Math.abs(r)}` : String(r);
};

/** «−18…−9 °C, пасмурно»; прогноза нет — null. */
export function shortWeather(d: ViewDay): string | null {
  const f = d.weatherForecast;
  if (!f || !Number.isFinite(f.tempMin) || !Number.isFinite(f.tempMax)) return null;
  return shortWeatherLine(f.tempMin, f.tempMax, f.description);
}

/** «−18…−9 °C, пасмурно» — одна строка погоды для плана, /trip и PDF. */
export function shortWeatherLine(tempMin: number, tempMax: number, description?: string | null): string | null {
  if (!Number.isFinite(tempMin) || !Number.isFinite(tempMax)) return null;
  const desc = description?.trim().toLowerCase();
  return `${signed(tempMin)}…${signed(tempMax)} °C${desc ? `, ${desc}` : ''}`;
}

/**
 * Совет по одежде всего плана — одной строкой (слово владельца 22.11): вещи
 * из строк погоды дней, у каждой — свои дни. Одинаковые дни у всех вещей —
 * дни один раз в конце.
 */
export function clothingAdvice(days: readonly ViewDay[]): { text: string; days: number[] } | null {
  const byItem = new Map<string, number[]>();
  for (const d of days) {
    const kit = kitAdvice(d.weatherKit);
    if (!kit) continue;
    for (const item of KIT_ITEMS) {
      if (kit.includes(item)) byItem.set(item, [...(byItem.get(item) ?? []), d.day]);
    }
  }
  if (byItem.size === 0) return null;
  const entries = [...byItem];
  const sameDays = entries.every(([, ds]) => ds.join() === entries[0][1].join());
  if (sameDays) return { text: `Одежда по прогнозу: возьмите ${entries.map(([i]) => i).join(', ')}.`, days: entries[0][1] };
  return { text: `Одежда по прогнозу: возьмите ${entries.map(([i, ds]) => `${i} (${daysWords(ds)})`).join('; ')}.`, days: [] };
}

/** Совет по одежде из строки погоды дня: «Возьмите …». */
function kitAdvice(kit: string | undefined): string | null {
  const m = kit ? /Возьмите [^.]+\./.exec(kit) : null;
  return m ? m[0] : null;
}

function daysWords(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return `${sorted.length > 1 ? 'дни' : 'день'} ${parts.join(', ')}`;
}

export interface SafetyItem { text: string; days: number[]; severity: 'critical' | 'important' | 'info' }

/** Предупреждения плана над днями — только про сам план (сроки, сезон, недобор). */
export function planShapeWarnings<W extends PlanWarningLike>(warnings: readonly W[]): W[] {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    if (!PLAN_SHAPE_TYPES.has(w.type)) return false;
    const k = norm(w.message);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Блок «Безопасность и разрешения»: всё, что не про сам план, и все строки
 * дней — каждая ОДИН раз, с днями, к которым она относилась; совет по
 * одежде — тоже один раз. Порядок: критичное, важное, справка.
 */
/** «День 8: », «Дни 3, 4: », «Дни 2–3: » в начале сводки плана. Диапазон «2–3» даёт оба конца. */
const DAY_LEAD = /^(?:День|Дни)\s+(\d+(?:\s*(?:,|и|–|-)\s*\d+)*)\s*:\s+/;

export function safetyBlock(days: readonly ViewDay[], warnings: readonly PlanWarningLike[]): SafetyItem[] {
  const items = new Map<string, SafetyItem>();
  const rank = { critical: 0, important: 1, info: 2 } as const;
  const add = (text: string, severity: SafetyItem['severity'], day?: number) => {
    const k = safetyKey(text);
    if (!k) return;
    const prev = items.get(k);
    const trimmed = text.trim();
    const it = prev ?? { text: trimmed, days: [], severity };
    if (prev && trimmed.length > prev.text.length) it.text = trimmed;
    if (day != null && !it.days.includes(day)) it.days.push(day);
    if (rank[severity] < rank[it.severity]) it.severity = severity;
    items.set(k, it);
  };
  for (const w of warnings) {
    if (PLAN_SHAPE_TYPES.has(w.type)) continue;
    const sev = (['critical', 'important', 'info'].includes(w.severity) ? w.severity : 'info') as SafetyItem['severity'];
    // Сводка плана «День 8: <строка дня>» — та же строка, что на самом дне
    // (PDF 24.11–4.12, 23.11: закрытие парка стояло в блоке дважды). Ключ —
    // текст без приставки дня, дни — в скобках, как у строк дней.
    const lead = DAY_LEAD.exec(w.message);
    const leadDays = lead ? [...lead[1].matchAll(/\d+/g)].map((m) => Number(m[0])) : [];
    if (lead && leadDays.length > 0) {
      const text = w.message.slice(lead[0].length);
      for (const day of leadDays) add(text, sev, day);
    } else add(w.message, sev);
  }
  // Строка дня о вулкане/дороге, место которой уже названо в сводке плана, —
  // второй раз в блоке не пишется (22.11); на самом дне она стоит.
  const planText = warnings.map((w) => w.message).join(' ').toLowerCase().replace(/ё/g, 'е');
  const saidInPlan = (text: string): boolean => {
    const m = /о вулкане ([^:]+):/.exec(text) ?? /вулкан (.+?) назван/.exec(text) ?? /проезд — ([^(.;—]+)/.exec(text);
    const place = m?.[1]?.trim().toLowerCase().replace(/ё/g, 'е');
    return Boolean(place) && planText.includes(place!);
  };
  for (const d of days) {
    for (const w of d.dayWarnings ?? []) if (!saidInPlan(w)) add(w, 'important', d.day);
  }
  // Длинная строка, внутри которой уже есть другая (от 40 знаков) — одна запись.
  // Короткие общие слова («парк», «ветер») не склеиваются.
  const keys = [...items.keys()];
  const drop = new Set<string>();
  for (const k of keys) {
    if (drop.has(k) || k.length < 40) continue;
    for (const k2 of keys) {
      if (k === k2 || drop.has(k2) || k2.length < 40) continue;
      if (k.includes(k2)) {
        const host = items.get(k)!;
        const guest = items.get(k2)!;
        for (const d of guest.days) if (!host.days.includes(d)) host.days.push(d);
        if (rank[guest.severity] < rank[host.severity]) host.severity = guest.severity;
        if (guest.text.length > host.text.length) host.text = guest.text;
        drop.add(k2);
      }
    }
  }
  for (const k of drop) items.delete(k);
  const clothing = clothingAdvice(days);
  if (clothing) items.set('__clothing', { text: clothing.text, days: clothing.days, severity: 'info' });
  return [...items.values()].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function safetyItemText(it: SafetyItem): string {
  return it.days.length > 0 ? `${it.text} (${daysWords(it.days)})` : it.text;
}

export interface TourRun { tourId: string; first: number; last: number }

/**
 * Многодневный тур — один блок: подряд идущие дни занятия с тем же туром.
 * Ключ — номер дня; у первого дня — весь отрезок, у остальных — тот же.
 */
export function tourRuns(days: readonly ViewDay[]): Map<number, TourRun> {
  const out = new Map<number, TourRun>();
  let i = 0;
  while (i < days.length) {
    const isActivity = (d: ViewDay) => (d.type ?? 'activity') === 'activity';
    const id = isActivity(days[i]) ? days[i].realTour?.tourId : undefined;
    let j = i;
    if (id) {
      while (j + 1 < days.length && isActivity(days[j + 1]) && days[j + 1].realTour?.tourId === id
        && days[j + 1].day === days[j].day + 1) j++;
    }
    if (id && j > i) {
      const run = { tourId: id, first: days[i].day, last: days[j].day };
      for (let k = i; k <= j; k++) out.set(days[k].day, run);
    }
    i = j + 1;
  }
  return out;
}

/** Заголовок блока многодневного тура: «Дни 1–5». */
export function runLabel(run: TourRun): string {
  return `Дни ${run.first}–${run.last}`;
}
