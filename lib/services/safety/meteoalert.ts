/**
 * Предупреждения Росгидромета по Камчатке — meteoalert.meteoinfo.ru (08.10).
 *
 * Зачем, если УГМС и так приходит: до этого дня штормовые предупреждения
 * доходили до ленты только пересказом — постом МЧС в VK, RSS или MAX, каждый
 * своими словами, без уровня и без срока. Формальный источник отдаёт то же
 * самое структурой: район, уровень (жёлтый / оранжевый / красный), явление,
 * текст и срок действия. Решение владельца 07.10 («го»): в приём тревог, а не
 * отдельным MCP-сервером — тогда предупреждение сразу видят радар, карточки
 * мест, Кузьмич, пуш и внешние агенты через safety_status.
 *
 * Адрес JSON взят из скрипта kammeteo.ru (информер), ключа не требует.
 * Форма ответа (проба с раннера 04.10):
 *
 *   {"0": {"<регион>": {"0": "Камчатский край, юг", "1": "12",
 *            "3": {"<ключ>": {"0": {"0": явление, "1": текст,
 *                                    "2": начало (unix), "3": длительность, мин}}}}},
 *    "1": сейчас (unix)}
 *
 * Ключ: первая цифра — уровень, остаток — род явления. `001` — «Оповещения о
 * погоде не требуется», `21` — жёлтый, ветер. Род явления здесь НЕ
 * расшифровывается по таблице: его название источник даёт словом («Ветер»),
 * и вид тревоги выводится из этого слова, а не из нашей памяти о кодах.
 *
 * Дубли с пересказами МЧС этим не устраняются, и это известно: заголовки
 * разные, контентный дедуп saveEvent их не сведёт. Звонок второй не придёт —
 * пуш глушится по типу, пока прежний действует (safety-ingest,
 * dispatchPushAlerts); на /safety будет на строку больше, зато с уровнем и
 * сроком. Убирать пересказы МЧС — отдельное решение, не это.
 */
import { saveEvent, titleFingerprint, type ParseResult, type SeismicEvent } from '@/lib/services/safety/seismic-parser';

/** Прямоугольник, которым спрашивает сам информер kammeteo.ru (весь край с запасом). */
export const METEOALERT_URL =
  'https://meteoalert.meteoinfo.ru/russia/informer/ajax_informer_1.php'
  + '?lon_0=151.45312540233135&lon_1=175.60546942055228&lat_0=50.018751221459&lat_1=65.25793871571221';

/** Страница, на которую ведёт тревога: карта предупреждений Гидрометцентра. */
export const METEOALERT_PAGE = 'https://meteoinfo.ru/warnings';

export const METEOALERT_PREFIX = 'meteoalert';

/**
 * Регионы Камчатки в ответе и наши зоны тревог.
 *
 * Границы «севера» и «юга» источник не называет. «Север» — северная зона
 * целиком. «Юг» накрывает все четыре: наша северная зона начинается с 55,5°
 * с. ш. (Ключи, Эссо, Усть-Камчатск), а где проходит граница УГМС, из ответа
 * не видно. Ошибиться в сторону лишнего жёлтого дешевле, чем потерять
 * штормовое у Ключевской группы (то же правило, что у зон МЧС: сужать молча
 * нельзя).
 */
export const METEOALERT_REGIONS: Readonly<Record<string, { label: string; zones: readonly string[] }>> = {
  '95': { label: 'север края', zones: ['northern'] },
  '96': { label: 'юг края', zones: ['avachinsky', 'eastern', 'western', 'northern'] },
};

const LEVEL: Readonly<Record<number, { word: string; meaning: string; severity: 1 | 2 | 3 }>> = {
  2: { word: 'жёлтый', meaning: 'потенциально опасно', severity: 1 },
  3: { word: 'оранжевый', meaning: 'опасно', severity: 2 },
  4: { word: 'красный', meaning: 'очень опасно', severity: 3 },
};

/**
 * Старше этого ответ информера — не «сейчас». Информер обновляется раз в час
 * (в пробе «сейчас» ровно на границе часа); шесть часов — с запасом.
 */
export const METEOALERT_MAX_AGE_HOURS = 6;

/** Срок, когда источник его не дал: сутки, и об этом сказано в тексте тревоги. */
const UNKNOWN_DURATION_HOURS = 24;

export interface MeteoWarning {
  regionId: string;
  /** Ключ источника как есть: `21`, `310`. */
  key: string;
  level: 2 | 3 | 4;
  phenomenon: string;
  text: string;
  startUnix: number;
  /** null — длительность не дана. */
  minutes: number | null;
}

export interface MeteoalertParsed {
  /** Регионы Камчатки, которые нашлись в ответе (жив = хотя бы один). */
  regions: string[];
  warnings: MeteoWarning[];
  /** «Сейчас» информера (`"1"`), unix. null — не дан. */
  nowUnix: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Разбор ответа. Не та форма — `null` (отказ источника, а не «тихо»).
 * Уровни ниже жёлтого (`0…` «не требуется», `1…`) — не предупреждения.
 */
export function parseMeteoalert(raw: unknown): MeteoalertParsed | null {
  if (!isObj(raw) || !isObj(raw['0'])) return null;
  const all = raw['0'];
  const out: MeteoalertParsed = { regions: [], warnings: [], nowUnix: num(raw['1']) };
  for (const regionId of Object.keys(METEOALERT_REGIONS)) {
    const region = all[regionId];
    if (!isObj(region)) continue;
    out.regions.push(regionId);
    const byKey = isObj(region['3']) ? region['3'] : {};
    for (const [key, items] of Object.entries(byKey)) {
      const level = Number(key.charAt(0));
      if (level !== 2 && level !== 3 && level !== 4) continue;
      if (!isObj(items)) continue;
      for (const item of Object.values(items)) {
        if (!isObj(item)) continue;
        const phenomenon = typeof item['0'] === 'string' ? item['0'].trim() : '';
        const text = typeof item['1'] === 'string' ? item['1'].trim() : '';
        const startUnix = num(item['2']);
        if (!phenomenon || startUnix === null) continue;
        const minutes = num(item['3']);
        out.warnings.push({
          regionId, key, level, phenomenon, text, startUnix,
          minutes: minutes !== null && minutes > 0 ? minutes : null,
        });
      }
    }
  }
  return out;
}

/** Вид тревоги — по слову источника. Чего не узнали — погода, не тишина. */
export function meteoAlertType(phenomenon: string): SeismicEvent['alert_type'] {
  const p = phenomenon.toLowerCase();
  if (/лавин/.test(p)) return 'avalanche';
  if (/пожар/.test(p)) return 'fire_danger';
  if (/павод|наводнен|половод|уровн/.test(p)) return 'flood';
  return 'weather';
}

function regionsLabel(ids: string[]): string {
  if (ids.length === Object.keys(METEOALERT_REGIONS).length) return 'север и юг края';
  return ids.map((id) => METEOALERT_REGIONS[id]?.label ?? id).join(', ');
}

/**
 * Предупреждения → события. Одинаковое предупреждение для севера и юга (так
 * чаще всего и бывает: «ветер в прибрежных районах 15-20 м/с» обоим) — одна
 * тревога с объединёнными зонами, а не две строки об одном.
 * Истёкшее к `nowMs` не возвращается.
 */
export function meteoalertEvents(warnings: MeteoWarning[], nowMs: number = Date.now()): SeismicEvent[] {
  const groups = new Map<string, { w: MeteoWarning; regions: string[] }>();
  for (const w of warnings) {
    const k = [w.key, w.phenomenon, w.text, w.startUnix, w.minutes].join('|');
    const g = groups.get(k);
    if (g) { if (!g.regions.includes(w.regionId)) g.regions.push(w.regionId); }
    else groups.set(k, { w, regions: [w.regionId] });
  }

  const events: SeismicEvent[] = [];
  for (const { w, regions } of groups.values()) {
    regions.sort();
    const startMs = w.startUnix * 1000;
    const endMs = startMs + (w.minutes !== null ? w.minutes * 60_000 : UNKNOWN_DURATION_HOURS * 3_600_000);
    if (endMs <= nowMs) continue;
    // Предупреждение «на завтра» действует уже сейчас — его и объявляют
    // заранее. Отсчёт срока — от момента, когда мы его увидели, до конца.
    const publishedMs = Math.min(startMs, nowMs);
    const hours = Math.max(1, Math.ceil((endMs - publishedMs) / 3_600_000));
    const level = LEVEL[w.level];
    const zones = [...new Set(regions.flatMap((id) => METEOALERT_REGIONS[id]?.zones ?? []))];
    const phenomenon = w.phenomenon.charAt(0).toLowerCase() + w.phenomenon.slice(1);
    const body = w.text ? (/[.!]$/.test(w.text) ? w.text : `${w.text}.`) : `${w.phenomenon}.`;
    events.push({
      source_id: `${METEOALERT_PREFIX}/${regions.join('+')}/${w.key}/${w.startUnix}/t${titleFingerprint(`${w.phenomenon} ${w.text}`)}`,
      source_url: METEOALERT_PAGE,
      published_at: new Date(publishedMs),
      alert_type: meteoAlertType(w.phenomenon),
      severity: level.severity,
      title: `Росгидромет: ${phenomenon} — ${level.word} уровень (${regionsLabel(regions)})`,
      // Срок в текст не пишется: он в expires_at, а текст — ключ контентного
      // дедупа. Продление того же предупреждения обязано продлевать строку,
      // а не заводить вторую.
      description: `${body} Уровень по шкале Росгидромета: ${level.word} — ${level.meaning}.`
        + (w.minutes === null ? ' Срок действия источник не указал.' : ''),
      affected_zones: zones,
      expires_hours: hours,
    });
  }
  return events;
}

export interface MeteoalertResult extends ParseResult {
  /** Регионы, которые ответ содержал, и сколько предупреждений у каждого. */
  regions: Array<{ id: string; label: string; warnings: number }>;
}

/** Приём: запрос → разбор → saveEvent. Отказ — в errors, не тишиной. */
export async function ingestMeteoalert(): Promise<MeteoalertResult> {
  const result: MeteoalertResult = { events: [], inserted: 0, skipped: 0, errors: [], regions: [] };
  try {
    const res = await fetch(METEOALERT_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VedarSafety/1.0; +https://vedarai.ru)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      result.errors.push(`meteoalert http ${res.status}`);
      return result;
    }
    const parsed = parseMeteoalert(await res.json() as unknown);
    if (!parsed) {
      result.errors.push('meteoalert: ответ не той формы');
      return result;
    }
    // Свежесть — по отметке самого информера. Без неё «регионы есть» ничего
    // не доказывает: застрявший кэш отдавал бы те же регионы сутками, и
    // здоровье источника считало бы его живым (так было с превью t.me).
    const ageHours = parsed.nowUnix === null ? null : (Date.now() / 1000 - parsed.nowUnix) / 3600;
    if (ageHours === null || ageHours > METEOALERT_MAX_AGE_HOURS) {
      result.errors.push(ageHours === null
        ? 'meteoalert: в ответе нет отметки времени информера'
        : `meteoalert: ответ информера устарел на ${Math.round(ageHours)} ч`);
      return result;
    }
    // Ноль регионов при ответе 200 — не «предупреждений нет», а «не нашли
    // Камчатку в ответе» (§4.0: ноль на входе — отказ).
    if (parsed.regions.length === 0) {
      result.errors.push(`meteoalert: в ответе нет регионов Камчатки (${Object.keys(METEOALERT_REGIONS).join(', ')})`);
      return result;
    }
    result.rawItems = parsed.regions.length;
    result.regions = parsed.regions.map((id) => ({
      id,
      label: METEOALERT_REGIONS[id].label,
      warnings: parsed.warnings.filter((w) => w.regionId === id).length,
    }));
    for (const event of meteoalertEvents(parsed.warnings)) {
      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  } catch (e) {
    result.errors.push(`meteoalert: ${(e as Error).message}`);
  }
  return result;
}
