/**
 * Официальный курс Банка России — для «≈ ¥» рядом с ценой в рублях на
 * китайских страницах (карт-бланш владельца 29.10 на бесплатные API).
 *
 * Цены туров у нас в рублях, и платит турист рублями; китайский турист
 * считает в юанях. Пересчёт — подсказка, а не цена: он называет курс,
 * его дату и источник, а рублёвая цена остаётся главной.
 *
 * Источник — `https://www.cbr.ru/scripts/XML_daily.asp`: без ключа, курсы на
 * дату в атрибуте `ValCurs Date`. Курс на завтра ЦБ публикует днём, поэтому
 * дата бывает следующей — она и показывается, а не «сегодня».
 *
 * Исходы (§4.0): курс прочитан — число и дата; нет — null, и страница
 * показывает только рубли. Курс не выдумывается. Удачный курс отказ не
 * затирает, пока ему меньше суток: дата курса показывается рядом с суммой, и
 * вчерашний курс с его датой — правда; старше суток — только рубли.
 *
 * Пересчёт — украшение цены, а не её часть: страница ждёт курс не дольше
 * двух секунд, а одновременные заходы ждут один запрос, а не шлют каждый свой.
 */

export const CBR_DAILY_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';

export interface CbrRate {
  /** Буквенный код валюты: «CNY». */
  code: string;
  /** Рублей за одну единицу валюты. */
  rubPerUnit: number;
  /** Дата курса ДД.ММ.ГГГГ — как в ответе ЦБ. */
  date: string;
}

/**
 * Курс валюты из ответа ЦБ. Число с запятой («11,0510») делится на номинал:
 * у части валют курс дан за 10 или 100 единиц.
 */
export function parseCbrRate(xml: string, code: string): CbrRate | null {
  const date = /<ValCurs[^>]*\bDate="(\d{2}\.\d{2}\.\d{4})"/.exec(xml)?.[1];
  if (!date) return null;
  const re = /<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    if (/<CharCode>([A-Z]{3})<\/CharCode>/.exec(body)?.[1] !== code) continue;
    const nominal = Number(/<Nominal>(\d+)<\/Nominal>/.exec(body)?.[1]);
    const value = Number((/<Value>([\d,.]+)<\/Value>/.exec(body)?.[1] ?? '').replace(',', '.'));
    if (!Number.isFinite(nominal) || nominal <= 0 || !Number.isFinite(value) || value <= 0) return null;
    return { code, rubPerUnit: value / nominal, date };
  }
  return null;
}

const RATE_TTL_MS = 6 * 60 * 60 * 1000;
const RATE_FAIL_TTL_MS = 10 * 60 * 1000;
/** Удачный курс переживает отказ ЦБ, пока ему меньше суток. */
const RATE_KEEP_MS = 24 * 60 * 60 * 1000;
const RATE_TIMEOUT_MS = 2_000;
const UA = 'Mozilla/5.0 (compatible; VedarBot/1.0; +https://vedarai.ru)';

let cache: { rate: CbrRate | null; expiresAt: number } | null = null;
/** Последний удачный курс и когда он прочитан — запас на время отказа ЦБ. */
let lastGood: { rate: CbrRate; at: number } | null = null;
/** Запрос в пути: одновременные заходы ждут его. */
let inFlight: Promise<CbrRate | null> | null = null;

/**
 * Курс юаня. Удачный помнится шесть часов, отказ — десять минут. При отказе —
 * последний удачный, если ему меньше суток, иначе null.
 */
export async function loadCnyRate(now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<CbrRate | null> {
  if (cache && cache.expiresAt > now.getTime()) return cache.rate;
  if (inFlight) return inFlight;
  inFlight = fetchCnyRate(fetchImpl).then((fresh) => {
    if (fresh) lastGood = { rate: fresh, at: now.getTime() };
    const kept = !fresh && lastGood && now.getTime() - lastGood.at < RATE_KEEP_MS ? lastGood.rate : null;
    const rate = fresh ?? kept;
    cache = { rate, expiresAt: now.getTime() + (fresh ? RATE_TTL_MS : RATE_FAIL_TTL_MS) };
    return rate;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchCnyRate(fetchImpl: typeof fetch): Promise<CbrRate | null> {
  let rate: CbrRate | null = null;
  try {
    const res = await fetchImpl(CBR_DAILY_URL, {
      headers: { 'user-agent': UA, accept: 'application/xml' },
      signal: AbortSignal.timeout(RATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[cbr-rate] HTTP ${res.status}`);
    } else {
      // Ответ в windows-1251; нужные поля — цифры и латиница, но разбираем честно.
      const xml = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
      rate = parseCbrRate(xml, 'CNY');
      if (!rate) console.error('[cbr-rate] в ответе ЦБ нет курса CNY или даты');
    }
  } catch (err: unknown) {
    console.error('[cbr-rate] курс не прочитан:', err instanceof Error ? err.message : String(err));
  }
  return rate;
}

/** Для тестов: забыть курс. */
export function resetCnyRateCache(): void {
  cache = null;
  lastGood = null;
  inFlight = null;
}

/**
 * «约 9,500 元» — сумма в юанях, округлённая по-честному грубо: до сотни от
 * тысячи, до десятка ниже. Точнее курс на день не даёт.
 */
export function approxYuan(rub: number, rate: CbrRate): string | null {
  if (!Number.isFinite(rub) || rub <= 0) return null;
  const y = rub / rate.rubPerUnit;
  const step = y >= 1000 ? 100 : 10;
  const rounded = Math.max(step, Math.round(y / step) * step);
  return `约 ${rounded.toLocaleString('zh-CN')} 元`;
}
