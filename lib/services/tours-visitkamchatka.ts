/**
 * lib/services/tours-visitkamchatka.ts
 *
 * Парсинг биржи туров tours.visitkamchatka.ru/tours
 * Стратегии (по убыванию надёжности):
 *   1. __NEXT_DATA__ JSON в HTML (Next.js SSR — самый надёжный, не требует JS)
 *   2. /api/tours и схожие REST-эндпоинты (если есть открытый API)
 *   3. HTML-парсинг через CSS-классы (fallback)
 *
 * Сохраняет в operator_tours + tour_availability.
 * Запускается через POST /api/admin/import/operators { action: "scrape_tours" }
 */

import { pool } from '@/lib/db-pool';
import { firecrawlScrape, firecrawlAvailable } from '@/lib/services/firecrawl';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const TOURS_BASE = 'https://tours.visitkamchatka.ru';
const TOURS_URL  = `${TOURS_BASE}/tours`;
const UA = 'Mozilla/5.0 (compatible; TourHabBot/1.0)';
const TIMEOUT = 20_000;

export interface TourSlot {
  title: string;
  operator_name?: string;
  activity_type: string;
  date_from?: string;
  date_to?: string;
  price?: number;
  currency: string;
  slots_available?: number;
  max_participants?: number;
  contact_tg?: string;
  source_url: string;
  duration_hours?: number;
  description?: string;
}

export interface ToursImportResult {
  total: number;
  inserted: number;
  matched_operators: number;
  errors: string[];
  tours: { title: string; date?: string; price?: number; status: string }[];
  debug?: {
    strategy: string;
    html_length?: number;
    next_data_found?: boolean;
    api_tried?: string[];
  };
}

// ── Fetch raw HTML ────────────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok ? res.text() : null;
  } catch {
    return null;
  }
}

// ── Fetch JSON API ────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;
    return await res.json() as unknown;
  } catch {
    return null;
  }
}

// ── Strategy 1: Extract __NEXT_DATA__ from HTML ───────────────────────────────

function extractNextData(html: string): TourSlot[] | null {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) return null;

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }

  // Walk known paths for tours in Next.js SSR props
  const candidates = [
    getNestedValue(data, ['props', 'pageProps', 'tours']),
    getNestedValue(data, ['props', 'pageProps', 'data', 'tours']),
    getNestedValue(data, ['props', 'pageProps', 'initialData', 'tours']),
    getNestedValue(data, ['props', 'pageProps', 'items']),
    getNestedValue(data, ['props', 'pageProps', 'products']),
    getNestedValue(data, ['props', 'pageProps', 'data', 'items']),
    getNestedValue(data, ['props', 'pageProps', 'catalog']),
    getNestedValue(data, ['props', 'pageProps', 'offers']),
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      const slots = candidate.map(item => parseNextDataItem(item)).filter(Boolean) as TourSlot[];
      if (slots.length > 0) return slots;
    }
  }

  // Deep search: find any array with tour-like objects
  const deepFound = deepSearchTours(data);
  return deepFound.length > 0 ? deepFound : null;
}

function getNestedValue(obj: unknown, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function deepSearchTours(obj: unknown, depth = 0): TourSlot[] {
  if (depth > 8 || !obj || typeof obj !== 'object') return [];

  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (first && typeof first === 'object') {
      const keys = Object.keys(first as object);
      // Looks like a tour array if it has title/name + price/cost fields
      const hasTitle = keys.some(k => /title|name|название|тур/i.test(k));
      const hasPrice = keys.some(k => /price|cost|цена|стоимость/i.test(k));
      if (hasTitle && hasPrice) {
        return obj.map(item => parseNextDataItem(item)).filter(Boolean) as TourSlot[];
      }
    }
  }

  if (!Array.isArray(obj)) {
    const results: TourSlot[] = [];
    for (const val of Object.values(obj as object)) {
      const sub = deepSearchTours(val, depth + 1);
      if (sub.length > 0) results.push(...sub);
    }
    return results;
  }

  return [];
}

function parseNextDataItem(item: unknown): TourSlot | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;

  const title = String(
    obj.title ?? obj.name ?? obj.название ?? obj.тур ?? ''
  ).trim();
  if (!title || title.length < 3) return null;

  const priceRaw = obj.price ?? obj.cost ?? obj.base_price ??
    obj.price_from ?? obj.min_price ?? obj.цена ?? obj.стоимость;
  const price = priceRaw ? parseFloat(String(priceRaw).replace(/[^\d.]/g, '')) : undefined;

  const operatorRaw = obj.operator ?? obj.operator_name ?? obj.agency ??
    obj.company ?? obj.оператор ?? obj.агентство ??
    getNestedValue(obj, ['operator', 'name']) ?? getNestedValue(obj, ['agency', 'name']);
  const operator_name = operatorRaw ? String(operatorRaw).trim() : undefined;

  const datesArr = Array.isArray(obj.dates) ? (obj.dates as unknown[])[0] : undefined;
  const dateFromRaw = obj.date_from ?? obj.start_date ?? obj.date_start ??
    obj.starts_at ?? obj.begin_date ?? datesArr ?? obj.departure_date;
  const dateToRaw = obj.date_to ?? obj.end_date ?? obj.date_end ?? obj.ends_at;

  const slotsRaw = obj.slots_available ?? obj.available_slots ??
    obj.seats ?? obj.places ?? obj.capacity ?? obj.available;

  const desc = String(obj.description ?? obj.desc ?? obj.excerpt ?? '').slice(0, 500);

  return {
    title,
    operator_name,
    activity_type: detectActivity(title + ' ' + desc),
    date_from: parseDate(String(dateFromRaw ?? '')),
    date_to: parseDate(String(dateToRaw ?? '')),
    price: price && !isNaN(price) ? Math.round(price) : undefined,
    currency: String(obj.currency ?? 'RUB'),
    slots_available: slotsRaw ? parseInt(String(slotsRaw), 10) : undefined,
    source_url: String(obj.url ?? obj.link ?? obj.href ?? TOURS_URL),
    description: desc || undefined,
  };
}

// ── Strategy 2: Probe known API endpoints ─────────────────────────────────────

const API_PROBES = [
  `${TOURS_BASE}/api/tours`,
  `${TOURS_BASE}/api/v1/tours`,
  `${TOURS_BASE}/api/v2/tours`,
  `${TOURS_BASE}/api/catalog/tours`,
  `${TOURS_BASE}/api/products`,
  `${TOURS_BASE}/api/offers`,
  `${TOURS_BASE}/api/tours?page=1&per_page=50`,
  `${TOURS_BASE}/api/tours?limit=50&offset=0`,
];

async function tryApiProbes(): Promise<{ tours: TourSlot[]; tried: string[] }> {
  const tried: string[] = [];

  for (const url of API_PROBES) {
    tried.push(url.replace(TOURS_BASE, ''));
    const data = await fetchJson(url);
    if (!data) continue;

    // Try to extract tours from various response shapes
    const candidates = [
      Array.isArray(data) ? data : null,
      getNestedValue(data, ['tours']),
      getNestedValue(data, ['data', 'tours']),
      getNestedValue(data, ['data']),
      getNestedValue(data, ['items']),
      getNestedValue(data, ['results']),
      getNestedValue(data, ['products']),
    ];

    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        const slots = c.map(item => parseNextDataItem(item)).filter(Boolean) as TourSlot[];
        if (slots.length > 0) return { tours: slots, tried };
      }
    }

    // Found valid JSON but couldn't extract — stop probing this one
    break;
  }

  return { tours: [], tried };
}

// ── Detect activity type ──────────────────────────────────────────────────────

function detectActivity(text: string): string {
  const t = text.toLowerCase();
  if (/вулкан|вилючинск|горел|мутновск|авачинск|корякск|ключевск|тарас|сопка/i.test(t)) return 'trekking';
  if (/рыбал|рыбы|рыболов/i.test(t)) return 'fishing';
  if (/вертол|ави|авиа/i.test(t)) return 'helicopter';
  if (/морск|катер|лодк|яхт|дайв|море|бухт/i.test(t)) return 'boat_trip';
  if (/сплав|рафт|каяк|река/i.test(t)) return 'rafting';
  if (/снегоход|сноуборд|лыж/i.test(t)) return 'snowmobile';
  if (/медвед|нерк|наблюд/i.test(t)) return 'bears';
  if (/джип|внедор|4x4/i.test(t)) return 'jeep';
  if (/купан|терм|источник|горяч|малки|паратунк/i.test(t)) return 'thermal';
  return 'trekking';
}

// ── Parse dates ───────────────────────────────────────────────────────────────

function parseDate(str: string): string | undefined {
  if (!str || str === 'undefined' || str === 'null') return undefined;
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const dmy = str.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  // Unix timestamp
  const ts = parseInt(str, 10);
  if (!isNaN(ts) && ts > 1_000_000_000) {
    return new Date(ts * (ts < 1e12 ? 1000 : 1)).toISOString().slice(0, 10);
  }
  // Russian month names
  const monthNames: Record<string, string> = {
    январ:'01',феврал:'02',март:'03',апрел:'04',
    мая:'05',май:'05',июн:'06',июл:'07',август:'08',
    сентябр:'09',октябр:'10',ноябр:'11',декабр:'12',
  };
  const ru = str.match(/(\d{1,2})\s+(январ\w*|феврал\w*|март\w*|апрел\w*|мая|май\w*|июн\w*|июл\w*|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*)\s+(\d{4})/i);
  if (ru) {
    const month = Object.entries(monthNames).find(([k]) => ru[2].toLowerCase().startsWith(k))?.[1] ?? '00';
    return `${ru[3]}-${month}-${ru[1].padStart(2,'0')}`;
  }
  return undefined;
}

// ── Parse price ───────────────────────────────────────────────────────────────

function parsePrice(str: string): number | undefined {
  const m = str.match(/(\d[\d\s]*\d|\d+)\s*(?:₽|руб|rub)/i);
  if (!m) return undefined;
  return parseInt(m[1].replace(/\s/g, ''), 10);
}

// ── Strategy 3: Parse tours from markdown (Firecrawl) ────────────────────────

function parseMarkdownTours(markdown: string): TourSlot[] {
  const tours: TourSlot[] = [];
  const sections = markdown.split(/\n(?=#{1,3}\s)/);

  for (const section of sections) {
    const titleMatch = section.match(/^#{1,3}\s+(.{5,150})/m);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim().replace(/\*+/g, '').trim();
    if (/навигация|меню|каталог|главная|фильтр/i.test(title)) continue;

    const price = parsePrice(section);
    const tgLinks = section.match(/t\.me\/([a-zA-Z0-9_]{4,})/g)?.[0];
    const dateMatches = [...section.matchAll(/\d{1,2}[./\s][а-яёА-ЯЁ]+[./\s]?\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{2}\.\d{4}/g)];
    const dates = dateMatches.map(m => parseDate(m[0])).filter(Boolean) as string[];
    const opMatch = section.match(/(?:оператор|компания|организат)[:\s]+([А-ЯЁA-Z][а-яёA-Za-z\s\-]{3,60})/i);
    const slotsMatch = section.match(/(\d+)\s*(?:мест|чел|человек|участник)/i);

    tours.push({
      title,
      operator_name: opMatch?.[1]?.trim(),
      activity_type: detectActivity(title + ' ' + section.slice(0, 300)),
      date_from: dates[0],
      date_to: dates[1] ?? dates[0],
      price,
      currency: 'RUB',
      slots_available: slotsMatch ? parseInt(slotsMatch[1], 10) : undefined,
      contact_tg: tgLinks ? `https://t.me/${tgLinks.replace('t.me/', '')}` : undefined,
      source_url: TOURS_URL,
      description: section.slice(0, 500).replace(/#{1,3}[^\n]+\n/, '').trim().slice(0, 300),
    });
  }

  return tours;
}

// ── Strategy 4: Parse tours from HTML (CSS classes fallback) ──────────────────

function parseHtmlTours(html: string): TourSlot[] {
  const tours: TourSlot[] = [];

  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Wide class pattern — cover many possible naming conventions
  const cardPattern = /<(?:div|article|li|section)[^>]*class="[^"]*(?:tour|card|item|product|offer|package|путевка|тур|catalog|listing|result|row)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|li|section)>/gi;
  let m: RegExpExecArray | null;

  while ((m = cardPattern.exec(cleaned)) !== null) {
    const block = m[1];
    const plain = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const titleMatch = block.match(/<(?:h[1-5]|strong|b)[^>]*>([^<]{5,200})<\/(?:h[1-5]|strong|b)>/i);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    if (/навигац|меню|главн/i.test(title)) continue;

    const price = parsePrice(plain);
    const dateMatches = [...plain.matchAll(/\d{1,2}\.\d{2}\.\d{4}/g)];
    const dates = dateMatches.map(m => parseDate(m[0])).filter(Boolean) as string[];
    const tgLink = block.match(/t\.me\/([a-zA-Z0-9_]{4,})/)?.[1];
    const opMatch = plain.match(/(?:оператор|компания|организат)[:\s]+([А-ЯЁ][а-яёA-Za-z\s\-]{3,60})/i);

    tours.push({
      title,
      operator_name: opMatch?.[1]?.trim(),
      activity_type: detectActivity(title + ' ' + plain.slice(0, 200)),
      date_from: dates[0],
      date_to: dates[1],
      price,
      currency: 'RUB',
      contact_tg: tgLink ? `https://t.me/${tgLink}` : undefined,
      source_url: TOURS_URL,
    });
  }

  return tours;
}

// ── Найти оператора в БД ──────────────────────────────────────────────────────

async function findOperatorId(operatorName: string): Promise<string | null> {
  if (!operatorName) return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM partners
     WHERE company_name ILIKE $1 OR name ILIKE $1
     LIMIT 1`,
    [`%${operatorName.slice(0, 50)}%`],
  );
  return rows[0]?.id ?? null;
}

// ── Upsert тур + слот ─────────────────────────────────────────────────────────

async function upsertTourSlot(slot: TourSlot): Promise<'inserted' | 'skip'> {
  let operatorId = slot.operator_name ? await findOperatorId(slot.operator_name) : null;

  // Если оператор не найден — создаём запись в partners
  if (!operatorId && slot.operator_name) {
    const name = slot.operator_name.slice(0, 200).trim();
    const slug = 'vk-tours-' + name.toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 70);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO partners (slug, company_name, name, external_source, external_source_url, is_verified, is_public, commission_current)
       VALUES ($1, $2, $2, 'visitkamchatka_tours', $3, false, false, 0)
       ON CONFLICT (slug) DO UPDATE SET company_name = EXCLUDED.company_name
       RETURNING id`,
      [slug, name, slot.source_url],
    );
    operatorId = rows[0]?.id ?? null;
  }

  if (!operatorId) return 'skip';

  const { rows: existing } = await pool.query<{ id: number }>(
    `SELECT id FROM operator_tours WHERE operator_id = $1 AND title = $2 LIMIT 1`,
    [operatorId, slot.title.slice(0, 255)],
  );

  let tourId: number;

  if (existing.length > 0) {
    tourId = existing[0].id;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO operator_tours (
         operator_id, title, description, activity_type,
         base_price, currency, is_active, is_published
       ) VALUES ($1,$2,$3,$4,$5,$6,true,false)
       RETURNING id`,
      [
        operatorId,
        slot.title.slice(0, 255),
        slot.description ?? null,
        slot.activity_type,
        slot.price ?? 0,
        slot.currency,
      ],
    );
    tourId = rows[0].id;
  }

  if (slot.date_from) {
    await pool.query(
      `INSERT INTO tour_availability (operator_tour_id, date, available_slots)
       VALUES ($1, $2, $3)
       ON CONFLICT (operator_tour_id, date) DO UPDATE
         SET available_slots = EXCLUDED.available_slots,
             updated_at = NOW()`,
      [tourId, slot.date_from, slot.slots_available ?? 1],
    );
  }

  return 'inserted';
}

// ── Главная функция ───────────────────────────────────────────────────────────

export async function scrapeTourMarketplace(filter?: {
  dateFrom?: string;
  dateTo?: string;
  activity?: string;
}): Promise<ToursImportResult> {
  const result: ToursImportResult = {
    total: 0,
    inserted: 0,
    matched_operators: 0,
    errors: [],
    tours: [],
    debug: { strategy: 'none', api_tried: [] },
  };

  let url = TOURS_URL;
  if (filter?.dateFrom) url += `?date_from=${filter.dateFrom}`;
  if (filter?.dateTo) url += `${url.includes('?') ? '&' : '?'}date_to=${filter.dateTo}`;

  let slots: TourSlot[] = [];
  let fetchedHtml: string | null = null;

  // ── Приоритет 1: Firecrawl → markdown парсинг ──────────────────────────────
  if (firecrawlAvailable()) {
    const page = await firecrawlScrape(url);
    if (page?.markdown) {
      slots = parseMarkdownTours(page.markdown);
      if (slots.length > 0) result.debug!.strategy = 'firecrawl_markdown';
    }
    if (page?.html && slots.length === 0) {
      fetchedHtml = page.html;
      const nextData = extractNextData(page.html);
      if (nextData && nextData.length > 0) {
        slots = nextData;
        result.debug!.strategy = 'firecrawl_next_data';
        result.debug!.next_data_found = true;
      } else {
        slots = parseHtmlTours(page.html);
        if (slots.length > 0) result.debug!.strategy = 'firecrawl_html';
      }
    }
  }

  // ── Приоритет 2: Прямой запрос к API эндпоинтам ──────────────────────────
  if (slots.length === 0) {
    const { tours: apiTours, tried } = await tryApiProbes();
    result.debug!.api_tried = tried;
    if (apiTours.length > 0) {
      slots = apiTours;
      result.debug!.strategy = 'json_api';
    }
  }

  // ── Приоритет 3: Bright Data → __NEXT_DATA__ → HTML парсинг ──────────────
  if (slots.length === 0) {
    const bdHtml = await fetchViaBrightData(url, { country: 'ru', timeoutMs: 35_000 });
    if (bdHtml) {
      fetchedHtml = bdHtml;
      result.debug!.html_length = bdHtml.length;

      const nextData = extractNextData(bdHtml);
      if (nextData && nextData.length > 0) {
        slots = nextData;
        result.debug!.strategy = 'bright_data_next_data';
        result.debug!.next_data_found = true;
      } else {
        slots = parseHtmlTours(bdHtml);
        if (slots.length > 0) result.debug!.strategy = 'bright_data_html';
      }
    }
  }

  // ── Приоритет 4: прямой fetch (часто 403) ────────────────────────────────
  if (slots.length === 0 && !fetchedHtml) {
    const html = await fetchPage(url);
    if (html) {
      fetchedHtml = html;
      result.debug!.html_length = html.length;
      const nextData = extractNextData(html);
      if (nextData && nextData.length > 0) {
        slots = nextData;
        result.debug!.strategy = 'direct_next_data';
        result.debug!.next_data_found = true;
      } else {
        slots = parseHtmlTours(html);
        if (slots.length > 0) result.debug!.strategy = 'direct_html';
      }
    }
  }

  if (!fetchedHtml && slots.length === 0) {
    result.errors.push(
      `Не удалось получить данные с ${TOURS_URL}. ` +
      `API пробы: ${result.debug?.api_tried?.join(', ') || 'нет'}.`
    );
    return result;
  }

  if (slots.length === 0) {
    const preview = fetchedHtml?.slice(0, 1000).replace(/\s+/g, ' ') ?? '';
    const hasNextData = /<script id="__NEXT_DATA__"/.test(fetchedHtml ?? '');
    result.errors.push(
      `HTML получен (${fetchedHtml?.length} байт), __NEXT_DATA__: ${hasNextData ? 'НАЙДЕН (но пустой?)' : 'не найден'}, ` +
      `стратегия HTML-парсинга не нашла туров. ` +
      `Превью: ${preview.slice(0, 400)}`
    );
    return result;
  }

  if (filter?.activity) {
    slots = slots.filter(s => s.activity_type === filter.activity);
  }
  if (filter?.dateFrom) {
    slots = slots.filter(s => !s.date_from || s.date_from >= filter.dateFrom!);
  }
  if (filter?.dateTo) {
    slots = slots.filter(s => !s.date_to || s.date_to <= filter.dateTo!);
  }

  result.total = slots.length;

  for (const slot of slots) {
    try {
      const status = await upsertTourSlot(slot);
      if (status === 'inserted') {
        result.inserted++;
        if (slot.operator_name) result.matched_operators++;
      }
      result.tours.push({ title: slot.title, date: slot.date_from, price: slot.price, status });
    } catch (e) {
      result.errors.push(`${slot.title}: ${(e as Error).message}`);
    }
  }

  return result;
}

// ── Функция для Debug — смотрит что возвращает Bright Data ──────────────────

export async function debugFetchTours(): Promise<{
  html_length: number;
  next_data_found: boolean;
  next_data_keys: string[];
  api_probes: { url: string; status: 'json' | 'html' | '403' | 'timeout' | 'error' }[];
  html_preview: string;
  top_classes: string[];
}> {
  const probeResults: { url: string; status: 'json' | 'html' | '403' | 'timeout' | 'error' }[] = [];

  for (const url of API_PROBES.slice(0, 5)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 403) probeResults.push({ url, status: '403' });
      else if (ct.includes('json')) probeResults.push({ url, status: 'json' });
      else if (ct.includes('html')) probeResults.push({ url, status: 'html' });
      else probeResults.push({ url, status: 'error' });
    } catch {
      probeResults.push({ url, status: 'timeout' });
    }
  }

  const html = await fetchViaBrightData(TOURS_URL, { country: 'ru', timeoutMs: 35_000 });
  if (!html) {
    return {
      html_length: 0,
      next_data_found: false,
      next_data_keys: [],
      api_probes: probeResults,
      html_preview: '',
      top_classes: [],
    };
  }

  const hasNextData = /<script id="__NEXT_DATA__"/.test(html);
  let nextDataKeys: string[] = [];

  if (hasNextData) {
    try {
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
      if (m) {
        const parsed = JSON.parse(m[1]) as Record<string, unknown>;
        const props = parsed?.props as Record<string, unknown> | undefined;
        const pageProps = props?.pageProps as Record<string, unknown> | undefined;
        nextDataKeys = Object.keys(pageProps ?? {});
      }
    } catch { /* ignore */ }
  }

  const classes = [...new Set(
    Array.from(html.matchAll(/class="([^"]+)"/g))
      .flatMap(m => m[1].split(/\s+/))
      .filter(c => c.length > 2 && c.length < 40)
  )];

  return {
    html_length: html.length,
    next_data_found: hasNextData,
    next_data_keys: nextDataKeys,
    api_probes: probeResults,
    html_preview: html.slice(0, 3000),
    top_classes: classes.slice(0, 40),
  };
}
