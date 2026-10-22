/**
 * Подписи страницы погоды — чистые функции, без запроса.
 *
 * Правила слов (снег, дождь или «осадки», порог «сухо») не заводятся здесь
 * второй раз: части дня говорят через `precipWords` из `lib/weather/day-parts`,
 * как у Кузьмича и сводки. Своё здесь только оформление: запятая в числах,
 * знак минуса, ветер в метрах в секунду — так его называют Росгидромет и
 * прогнозы, к которым привыкли на Камчатке.
 */
import type { ForecastDay } from '@/lib/planner/intelligence';
import { PRECIP_DRY_MM, precipWords, keepDailyDescription, type DayPart } from '@/lib/weather/day-parts';
import { elevationNote } from '@/lib/kuzmich/weather-tool';
import { pluralWarnings } from '@/lib/home/safety-pill';

const MINUS = '−';

/** «+5», «−3», «0». null — «?»: пропуск не становится нулём. */
export function fmtTemp(v: number | null): string {
  if (v === null) return '?';
  const r = Math.round(v);
  if (r > 0) return `+${r}`;
  if (r < 0) return `${MINUS}${Math.abs(r)}`;
  return '0';
}

/** «+2…+7°», «−3°» при одной границе, null — нет обеих. */
export function tempRange(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min === null || max === null) return `${fmtTemp(min ?? max)}°`;
  return Math.round(min) === Math.round(max) ? `${fmtTemp(max)}°` : `${fmtTemp(min)}…${fmtTemp(max)}°`;
}

/** Десятичная запятая: «0,8». */
export function fmtNumber(v: number, digits = 1): string {
  return v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

/** Ветер в м/с из км/ч Open-Meteo: «до 12 м/с». null — «ветер — нет данных». */
export function windLine(kmh: number | null): string {
  if (kmh === null) return 'ветер — нет данных';
  return `ветер до ${Math.round(kmh / 3.6)} м/с`;
}

/** Осадки дня: «без осадков», «осадки 3,6 мм», «осадки — нет данных». */
export function precipLine(mm: number | null): string {
  if (mm === null) return 'осадки — нет данных';
  if (mm < PRECIP_DRY_MM) return 'без осадков';
  return `осадки ${fmtNumber(mm)} мм`;
}

/** Осадки части дня — правилом `precipWords`, с десятичной запятой. */
export function partPrecip(p: DayPart): string {
  return precipWords(p).replace(/(\d)\.(\d)/g, '$1,$2');
}

/**
 * Небо дня словами — только там, где его не перекрывают части дня: при
 * частях суточная подпись осадков прячется (#2249), остаётся небо сухого
 * дня («ясно», «пасмурно», «туман») и гроза.
 */
export function skyWords(d: ForecastDay): string | null {
  if (!d.description) return null;
  return keepDailyDescription(d.weatherCode, (d.parts ?? []).length > 0) ? d.description : null;
}

const DAY_MS = 86_400_000;

/** «Сегодня», «Завтра», дальше — «сб, 11 октября». Даты — по Камчатке. */
export function dayLabel(date: string, today: string): string {
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

/** «8 октября в 14:05» по Камчатке; null — не дано. */
export function kamchatkaTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kamchatka',
  });
}

/** «Высота точки ~2710 м — прогноз для этой высоты, ниже теплее и обычно тише». */
export function elevationLine(elevationM: number | null): string | null {
  const note = elevationNote(elevationM).replace(/^,\s*/, '');
  return note ? note.charAt(0).toUpperCase() + note.slice(1) : null;
}

/** Направление ветра словами по градусам: «северо-западный». null — нет данных. */
export function windDirectionWords(deg: number | null | undefined): string | null {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return null;
  const dirs = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Ветер одной строкой: «3 м/с, порывы 6 м/с, северо-западный». */
export function windDetail(windKmh: number | null | undefined, gustKmh: number | null | undefined, dirDeg: number | null | undefined): string {
  const parts: string[] = [];
  if (windKmh !== null && windKmh !== undefined) parts.push(`${Math.round(windKmh / 3.6)} м/с`);
  if (gustKmh !== null && gustKmh !== undefined) parts.push(`порывы ${Math.round(gustKmh / 3.6)} м/с`);
  const dir = windDirectionWords(dirDeg);
  if (dir) parts.push(dir);
  return parts.length ? parts.join(' · ') : 'нет данных';
}

/** Видимость: метры в километры, «25 км» / «800 м». */
export function visibilityLine(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return 'нет данных';
  if (m >= 1000) return `${fmtNumber(m / 1000, m >= 10000 ? 0 : 1)} км`;
  return `${Math.round(m)} м`;
}

/** Давление гПа → мм рт. ст., целым; нет данных — null. */
export function pressureMm(hpa: number | null | undefined): number | null {
  if (hpa === null || hpa === undefined || !Number.isFinite(hpa)) return null;
  return Math.round(hpa * 0.75006);
}

/** Давление гПа → мм рт. ст. одной строкой. */
export function pressureLine(hpa: number | null | undefined): string {
  const mm = pressureMm(hpa);
  return mm === null ? 'нет данных' : `${mm} мм рт. ст.`;
}

/** УФ-индекс словами уровня. */
export function uvWords(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'нет данных';
  const label = v < 3 ? 'низкий' : v < 6 ? 'умеренный' : v < 8 ? 'высокий' : v < 11 ? 'очень высокий' : 'экстремальный';
  return `${fmtNumber(v, 1)} · ${label}`;
}

const LEVEL_WORD = { 1: 'жёлтый', 2: 'оранжевый', 3: 'красный' } as const;

/**
 * Свёрнутые предупреждения одной строкой (владелец 22.10: «этот блок нужно
 * свернуть, а то пока до погоды долистать не у всех терпение хватит»):
 * «3 предупреждения · высший уровень — оранжевый» и явления «Ветер, дождь».
 * Свёрнут текст, а не сигнал: сколько их и насколько опасно — видно сразу.
 * Список пуст — null: сворачивать нечего.
 */
export function warningsSummary(items: ReadonlyArray<{ title: string; severity: 1 | 2 | 3 }>): {
  line: string; phenomena: string; highest: 1 | 2 | 3;
} | null {
  if (items.length === 0) return null;
  const highest = items.reduce<1 | 2 | 3>((m, w) => (w.severity > m ? w.severity : m), 1);
  const names = [...new Set(items.map((w) => w.title.split(' — ')[0].trim().toLowerCase()).filter(Boolean))];
  const phenomena = names.join(', ');
  return {
    line: `${items.length} ${pluralWarnings(items.length)} · высший уровень — ${LEVEL_WORD[highest]}`,
    phenomena: phenomena.charAt(0).toUpperCase() + phenomena.slice(1),
    highest,
  };
}

/** Время из местного ISO «2026-10-20T07:59» → «07:59». */
export function hhmm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : null;
}
