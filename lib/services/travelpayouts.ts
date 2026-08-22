/**
 * TravelPayouts affiliate link service.
 * Server-side only — API key never exposed to client.
 *
 * API: POST https://api.travelpayouts.com/links/v1/create
 * Docs: https://support.travelpayouts.com/hc/ru/articles/25289759198226
 *
 * Rate limit: 100 req/min per marker.
 * Cache: in-memory, 6h TTL (links don't change).
 */

const API_URL  = 'https://api.travelpayouts.com/links/v1/create';
const MARKER   = process.env.TRAVELPAYOUTS_MARKER  ?? '402896';
const TRS      = process.env.TRAVELPAYOUTS_TRS     ?? '513488';
const TOKEN    = process.env.TRAVELPAYOUTS_API_TOKEN ?? '';

// ── In-memory cache ────────────────────────────────────────────────────────────

const cache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCached(url: string): string | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(url); return null; }
  return entry.url;
}

function setCached(original: string, affiliate: string): void {
  cache.set(original, { url: affiliate, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Core converter ─────────────────────────────────────────────────────────────

export interface AffiliateResult {
  affiliate_url: string;
  cached: boolean;
  error?: string;
}

/**
 * Convert one brand URL to an affiliate link.
 * Falls back to the original URL if conversion fails.
 */
export async function toAffiliateLink(
  url: string,
  subId?: string
): Promise<AffiliateResult> {
  const cached = getCached(url);
  if (cached) return { affiliate_url: cached, cached: true };

  if (!TOKEN) {
    return { affiliate_url: buildFallbackUrl(url), cached: false, error: 'no_token' };
  }

  try {
    const body = {
      trs:    parseInt(TRS, 10),
      marker: parseInt(MARKER, 10),
      shorten: true,
      links: [{ url, sub_id: subId ?? 'kamchatour' }],
    };

    const res = await fetch(API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Access-Token': TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { affiliate_url: buildFallbackUrl(url), cached: false, error: `http_${res.status}` };
    }

    const data = await res.json() as {
      code: string;
      result?: { links?: Array<{ code: string; partner_url: string }> };
    };

    const link = data.result?.links?.[0];
    if (link?.code === 'success' && link.partner_url) {
      setCached(url, link.partner_url);
      return { affiliate_url: link.partner_url, cached: false };
    }

    return {
      affiliate_url: buildFallbackUrl(url),
      cached: false,
      error: link?.code ?? 'unknown',
    };
  } catch (err) {
    return {
      affiliate_url: buildFallbackUrl(url),
      cached: false,
      error: err instanceof Error ? err.message : 'fetch_error',
    };
  }
}

// toAffiliateLinks убрана 22.08.2026 вслед за getKamchatkaAffiliateLinks —
// своим единственным потребителем. Одиночная toAffiliateLink остаётся: её
// зовёт /api/affiliate/link.

// ── Pre-built Kamchatka URLs ───────────────────────────────────────────────────

/** Standard entry points for Kamchatka tourists */
export const KAMCHATKA_URLS = {
  // Авиабилеты
  flights_to_pkc: 'https://avito.tpk.lu/OtGbiCh3?erid=2VtzqvJmcJA',
  cheap_calendar: 'https://www.aviasales.ru/search/MOW0000PKC1?marker=402896',

  // Проживание
  ostrovok_hotels: 'https://ostrovok.ru/hotel/russia/petropavlovsk_kamchatsky/',
  sutochno_apts: 'https://sutochno.ru/petropavlovsk-kamchatskiy',

  // Экскурсии и активности
  tripster_excursions: 'https://experience.tripster.ru',
  sputnik8_tours: 'https://www.sputnik8.com/ru/petropavlovsk-kamchatsky',

  // Трансферы
  kiwitaxi_airport: 'https://www.kiwitaxi.ru/airport/petropavlovsk-kamchatskij',

  // Страховка путешественника
  cherehapa_insurance: 'https://www.cherehapa.ru',
} as const;

// getKamchatkaAffiliateLinks убрана 22.08.2026 (перепись).
//
// Собирала все партнёрские ссылки разом «для передачи на страницу». Место
// таких блоков — страница поездки или маршрута; с карточки тура они убраны
// решением владельца (§11): под карточкой НАШЕГО проверенного оператора
// рекламный дисклеймер с ИНН постороннего юрлица читается как подмена
// продавца.

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Fallback: add marker param directly to the URL */
function buildFallbackUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('marker', MARKER);
    return u.toString();
  } catch {
    return url;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}
