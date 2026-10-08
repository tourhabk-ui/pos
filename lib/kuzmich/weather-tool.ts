/**
 * Погода МЕСТА или ТОЧКИ — одно правило для Кузьмича и MCP (25.09).
 *
 * До этого дня инструмент `get_weather`, который видят Кузьмич и внешние
 * агенты через MCP, не принимал аргументов вовсе: схема пустая, описание
 * «текущая погода в Петропавловске-Камчатском». Английское описание в
 * реестре MCP при этом обещало «place or coordinates» — обещание без
 * исполнения (правило 10.09). Человек на перевале получал город: между
 * Петропавловском и Мутновским тридцать километров по прямой и километр по
 * высоте, и решение «идти сегодня» принимается по погоде там, а не тут.
 *
 * Источник прогноза на платформе один — Open-Meteo через
 * `lib/planner/intelligence` (тот же, что у планера и SDK-инструмента);
 * второго здесь не заводится.
 *
 * Исходы названы словами (§4.0): место не найдено, координаты не разобраны,
 * прогноз не пришёл — это разные ответы, и ни один не выдаётся за погоду.
 */
import { pool } from '@/lib/db-pool';
import { fetchForecastDays, type ForecastDay } from '@/lib/planner/intelligence';
import { insideKrai } from '@/lib/geo/krai-envelope';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { containsPattern } from '@/lib/db/like';
import { dayPartsPhrase, keepDailyDescription } from '@/lib/weather/day-parts';
import { METEOALERT_PREFIX } from '@/lib/services/safety/meteoalert';

export const DEFAULT_WEATHER_PLACE = { name: 'Петропавловск-Камчатский', lat: 53.02, lng: 158.65 } as const;
export const WEATHER_DAYS_DEFAULT = 3;
export const WEATHER_DAYS_MAX = 7;

/**
 * Посёлки, которых нет в каталоге мест (`places` — это объекты маршрутов, а не
 * населённые пункты): по ним погоду спрашивают, а поиск по имени находил
 * ничего или «Вид на …». Координаты — центр посёлка, из задачи #2249 (08.10).
 */
export const WEATHER_SETTLEMENTS: ReadonlyArray<{ name: string; lat: number; lng: number }> = [
  { name: 'Ключи', lat: 56.32, lng: 160.85 },
  { name: 'Усть-Камчатск', lat: 56.22, lng: 162.48 },
  { name: 'Соболево', lat: 54.30, lng: 155.95 },
  { name: 'Палана', lat: 59.08, lng: 159.95 },
];

/** «п. Ключи», «Ключах», «пгт Палана» — посёлок из списка выше; null — не он. */
export function settlementByName(name: string): { name: string; lat: number; lng: number } | null {
  const q = name.trim().toLowerCase().replace(/ё/g, 'е')
    .replace(/^(пгт|пос(елок)?|п|с(ело)?)\.?\s+/, '');
  return WEATHER_SETTLEMENTS.find((s) => {
    const n = s.name.toLowerCase();
    // Основа без последней буквы — «Ключи/Ключах», «Палана/Палане», «Соболево/Соболеве».
    return q === n || (q.length >= 4 && q.startsWith(n.slice(0, -1)) && q.length <= n.length + 2);
  }) ?? null;
}

/**
 * Координаты живой точки по её имени. Ровно тот предикат живости, что у
 * переписей: скрытые и слитые записи не считаются местом.
 */
export async function resolvePlaceCoords(
  name: string,
): Promise<{ name: string; lat: number; lng: number } | null> {
  // Город — центром города, а не первым местом с этим словом в имени (#2249:
  // «Петропавловск» уходил в «Вид на Петропавловск-Камчатский», 12 км к ЮЗ).
  if (isCityQuery(name)) return { ...DEFAULT_WEATHER_PLACE };
  const settlement = settlementByName(name);
  if (settlement) return { ...settlement };
  const { rows } = await pool.query<{ name: string; lat: number; lng: number }>(
    `SELECT name, lat::float AS lat, lng::float AS lng
       FROM places
      WHERE name ILIKE $1
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND is_visible = true AND merged_into_id IS NULL
      ORDER BY (lower(name) = lower($2)) DESC, length(name) ASC
      LIMIT 1`,
    [containsPattern(name), name.trim()],
  );
  return rows[0] ?? null;
}

/** «Петропавловск», «Петропавловск-Камчатский», «г. Петропавловск», «ПК» — сам город. */
export function isCityQuery(name: string): boolean {
  const q = name.trim().toLowerCase().replace(/ё/g, 'е').replace(/^г\.?\s*/, '');
  return /^петропавловск(-?\s*камчатск(ий|ом|ого)?)?$/.test(q) || q === 'пк' || q === 'пкк';
}

/** Число из строки агента: «53.26» и «53,26» — одно и то же. null — не число. */
export function parseCoord(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export type WeatherTarget =
  | { kind: 'point'; name: string; lat: number; lng: number; outsideKrai: boolean }
  | { kind: 'place'; query: string }
  | { kind: 'default' }
  | { kind: 'invalid'; message: string };

/**
 * Что спрошено. Координаты главнее имени: их прислали, чтобы не гадать по
 * справочнику. Одна координата без второй — не точка, а ошибка агента, и
 * молча подставлять город вместо неё нельзя.
 */
export function weatherTarget(args: { place?: string; lat?: string; lng?: string }): WeatherTarget {
  const hasLat = args.lat !== undefined;
  const hasLng = args.lng !== undefined;
  if (hasLat || hasLng) {
    if (!hasLat || !hasLng) {
      return { kind: 'invalid', message: 'Нужны обе координаты — lat и lng. По одной точку не найти, погоду не выдаю.' };
    }
    const lat = parseCoord(args.lat);
    const lng = parseCoord(args.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { kind: 'invalid', message: `Координаты «${args.lat}, ${args.lng}» не разобраны: нужны градусы, широта от -90 до 90, долгота от -180 до 180.` };
    }
    // Огрубление до сотых (~1 км): агент может прислать геопозицию человека,
    // а прогнозу хватает сетки Open-Meteo. Точная координата не уходит ни в
    // зарубежный сервис, ни в лог прода (проверка MCP 29.09).
    const cLat = coarse(lat);
    const cLng = coarse(lng);
    return {
      kind: 'point',
      name: `точка ${cLat.toFixed(2)}, ${cLng.toFixed(2)}`,
      lat: cLat, lng: cLng,
      outsideKrai: insideKrai(lat, lng) === false,
    };
  }
  if (args.place) return { kind: 'place', query: args.place };
  return { kind: 'default' };
}

/** Сотые градуса — около километра: точнее прогноз не бывает, а человека выдаёт. */
function coarse(v: number): number {
  return Math.round(v * 100) / 100;
}

export function parseDays(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return WEATHER_DAYS_DEFAULT;
  return Math.min(WEATHER_DAYS_MAX, n);
}

function fmtTemp(v: number | null): string {
  if (v === null) return '?';
  const r = Math.round(v);
  return r > 0 ? `+${r}` : String(r);
}

/**
 * Строка дня. Пропуск в прогнозе — «нет данных», а не ноль: ноль ветра
 * читается штилем, ноль осадков — сухим днём.
 */
export function forecastLine(d: ForecastDay): string {
  const [, m, day] = d.date.split('-');
  const temp = d.tempMin === null && d.tempMax === null ? 'температура — нет данных' : `${fmtTemp(d.tempMin)}…${fmtTemp(d.tempMax)}°C`;
  const precip = d.precipMm === null ? 'осадки — нет данных' : `осадки ${d.precipMm} мм`;
  const wind = d.windKmh === null ? 'ветер — нет данных' : `ветер до ${Math.round(d.windKmh)} км/ч`;
  const parts = d.parts ?? [];
  // Суточная подпись осадков — «худшее за сутки» (#2249): при частях дня она
  // прячется, части говорят, когда и сколько.
  const sky = keepDailyDescription(d.weatherCode, parts.length > 0)
    ? `, ${d.description ?? 'небо — нет данных'}`
    : '';
  const byPart = parts.length > 0 ? `; по частям дня: ${dayPartsPhrase(parts)}` : '';
  return `${day}.${m}: ${temp}, ${precip}, ${wind}${sky}${byPart}`;
}

/**
 * Высота точки прогноза словами (#2249, 07.10). Без неё прогноз вершины
 * читался прогнозом похода: «Авачинский: −15…−9, снег» — это 2700 м, у
 * подножия около нуля. Выше 500 м — прямое предупреждение, что ниже иначе.
 */
export function elevationNote(elevationM: number | null | undefined): string {
  if (elevationM == null) return '';
  const h = Math.round(elevationM / 10) * 10;
  return h >= 500
    ? `, высота точки ~${h} м — прогноз для этой высоты, ниже теплее и обычно тише`
    : `, высота точки ~${h} м`;
}

function kamchatkaTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Kamchatka', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Ответ инструмента `get_weather` — текстом для модели. */
/**
 * Зоны тревог для точки — по той же границе, что у приёма Росгидромета
 * (lib/services/safety/meteoalert): север края — от 55,5° с. ш. Юг у
 * Росгидромета накрывает все наши зоны, поэтому южной точке годится любая
 * не-северная зона; называем все три, чтобы не зависеть от деления юга.
 */
export function alertZonesForPoint(lat: number): string[] {
  return lat >= 55.5 ? ['northern'] : ['avachinsky', 'eastern', 'western'];
}

/**
 * Действующие предупреждения Росгидромета для района точки (#2289, п. 3).
 *
 * Прогноз модели и официальное предупреждение — разные вещи, и человек
 * должен видеть оба: модель говорит «ветер 11 км/ч», а Росгидромет в тот же
 * день держит оранжевый по ветру на побережье. Предупреждения приходят в
 * external_alerts приёмом safety-ingest (meteoalert); своего запроса к
 * Гидрометцентру здесь нет.
 *
 * Три исхода (§4.0): строки предупреждений; пусто — ничего не добавляем
 * (не «предупреждений нет»: приём мог молчать, и это утверждение было бы
 * без источника); не смогли прочитать — так и сказано.
 */
export async function officialWarningLines(lat: number): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ title: string; description: string | null }>(
      `SELECT title, description
         FROM external_alerts
        WHERE external_id LIKE $1
          AND expires_at > NOW()
          AND affected_zones && $2::text[]
        ORDER BY severity DESC NULLS LAST, created_at DESC
        LIMIT 5`,
      [`${METEOALERT_PREFIX}/%`, alertZonesForPoint(lat)],
    );
    if (rows.length === 0) return [];
    return [
      'ДЕЙСТВУЮЩИЕ ПРЕДУПРЕЖДЕНИЯ РОСГИДРОМЕТА для этого района (официальный источник важнее прогноза модели — назови их):',
      ...rows.map((r) => `- ${r.title}${r.description ? `. ${r.description}` : ''}`),
    ];
  } catch (err) {
    logSwallowedFailure('kuzmich', 'предупреждения Росгидромета для прогноза', err);
    return ['Предупреждения Росгидромета проверить не смог — не утверждай, что их нет.'];
  }
}

export async function weatherForKuzmich(args: { place?: string; lat?: string; lng?: string; days?: string }): Promise<string> {
  const target = weatherTarget(args);
  if (target.kind === 'invalid') return target.message;
  const days = parseDays(args.days);

  let point: { name: string; lat: number; lng: number };
  let note = '';
  try {
    if (target.kind === 'point') {
      point = target;
      if (target.outsideKrai) note = ' Точка вне Камчатского края — прогноз дан, но это не наш район.';
    } else if (target.kind === 'place') {
      const found = await resolvePlaceCoords(target.query);
      if (!found) {
        return `Места «${target.query}» нет в справочнике платформы — прогноз именно для него дать не могу. `
          + 'Можно спросить по координатам (lat, lng). Погоду другого места не выдавай за его погоду.';
      }
      point = found;
    } else {
      point = DEFAULT_WEATHER_PLACE;
      note = ' Место не названо — это Петропавловск-Камчатский, в горах погода другая.';
    }
    const forecast = await fetchForecastDays(point.lat, point.lng, days);
    if (!forecast.ok || forecast.days.length === 0) {
      const why = forecast.ok ? 'пустой прогноз' : forecast.reason;
      console.error('[weather-tool] прогноз не получен:', point.name, why);
      return `ПОГОДА НЕДОСТУПНА для «${point.name}»: прогноз не пришёл (${why}). Не называй погоду по памяти — скажи, что проверить не смог.`;
    }
    const head = `Прогноз Open-Meteo для «${point.name}» (${point.lat.toFixed(2)}, ${point.lng.toFixed(2)})`
      + `${elevationNote(forecast.elevationM)}, дней: ${forecast.days.length}.${note}`
      + `${forecast.staleSince ? ` ВНИМАНИЕ: источник сейчас не отвечает — это последний полученный прогноз, от ${kamchatkaTime(forecast.staleSince)} по Камчатке; так и скажи.` : ''}`;
    const warnings = await officialWarningLines(point.lat);
    return [head, ...forecast.days.map(forecastLine), ...warnings].join('\n');
  } catch (err) {
    logSwallowedFailure('kuzmich', 'прогноз погоды по месту', err);
    return 'ПОГОДА НЕДОСТУПНА: свериться с прогнозом не удалось — не называй погоду по памяти.';
  }
}
