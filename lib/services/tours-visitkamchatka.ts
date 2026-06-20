/**
 * lib/services/tours-visitkamchatka.ts
 *
 * Парсинг биржи туров tours.visitkamchatka.ru/tours
 * Извлекает конкретные туры с датами, ценами и операторами.
 * Сохраняет в operator_tours + tour_availability.
 *
 * Запускается через POST /api/admin/import/operators { action: "scrape_tours" }
 */

import { pool } from '@/lib/db-pool';
import { firecrawlScrape, firecrawlAvailable } from '@/lib/services/firecrawl';

const TOURS_BASE = 'https://tours.visitkamchatka.ru';
const TOURS_URL  = `${TOURS_BASE}/tours`;
const UA = 'TourHab/1.0 (KamchatourHub tours importer)';
const TIMEOUT = 15_000;

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
}

// ── Fetch raw HTML ────────────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok ? res.text() : null;
  } catch {
    return null;
  }
}

// ── Detect activity type ──────────────────────────────────────────────────────

function detectActivity(text: string): string {
  const t = text.toLowerCase();
  if (/вулкан|вилючинск|горел|мутновск|авачинск|корякск|ключевск/i.test(t)) return 'trekking';
  if (/рыбал|рыбы|рыболов/i.test(t)) return 'fishing';
  if (/вертол|ави/i.test(t)) return 'helicopter';
  if (/морск|катер|лодк|яхт|дайв/i.test(t)) return 'boat_trip';
  if (/сплав|рафт|каяк/i.test(t)) return 'rafting';
  if (/снегоход|сноуборд|лыж/i.test(t)) return 'snowmobile';
  if (/медвед|нерк|рыб/i.test(t)) return 'bears';
  if (/джип|внедор/i.test(t)) return 'jeep';
  if (/купан|терм|источник|горяч/i.test(t)) return 'thermal';
  return 'trekking';
}

// ── Parse dates ───────────────────────────────────────────────────────────────

function parseDate(str: string): string | undefined {
  // Форматы: "03.08.2026", "3 августа 2026", "03/08/2026", "2026-08-03"
  const iso = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const dmy = str.match(/(\d{1,2})[\./](\d{1,2})[\./](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
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

// ── Parse tours from markdown ─────────────────────────────────────────────────

function parseMarkdownTours(markdown: string): TourSlot[] {
  const tours: TourSlot[] = [];
  const sections = markdown.split(/\n(?=#{1,3}\s)/);

  for (const section of sections) {
    const titleMatch = section.match(/^#{1,3}\s+(.{5,150})/m);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim().replace(/\*+/g, '').trim();
    if (/навигация|меню|каталог|главная/i.test(title)) continue;

    const price = parsePrice(section);
    const tgLinks = section.match(/t\.me\/([a-zA-Z0-9_]{4,})/g)?.[0];

    // Ищем даты
    const dateMatches = [...section.matchAll(/\d{1,2}[./\s][а-яёА-ЯЁ]+[./\s]?\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{2}\.\d{4}/g)];
    const dates = dateMatches.map(m => parseDate(m[0])).filter(Boolean) as string[];

    // Оператор из текста (ищем после "Оператор:", "Компания:")
    const opMatch = section.match(/(?:оператор|компания|организат)[:\s]+([А-ЯЁA-Z][а-яёA-Za-z\s\-]{3,60})/i);

    // Вместимость
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

// ── Parse tours from HTML (fallback) ─────────────────────────────────────────

function parseHtmlTours(html: string): TourSlot[] {
  const tours: TourSlot[] = [];
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const cardRe = /<(?:div|article)[^>]*class="[^"]*(?:tour|card|item|product)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article)>/gi;
  let m: RegExpExecArray | null;

  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1];
    const plain = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const titleMatch = block.match(/<(?:h[2-4]|strong)[^>]*>([^<]{5,150})<\/(?:h[2-4]|strong)>/i);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const price = parsePrice(plain);
    const dateMatches = [...plain.matchAll(/\d{1,2}\.\d{2}\.\d{4}/g)];
    const dates = dateMatches.map(m => parseDate(m[0])).filter(Boolean) as string[];
    const tgLinks = block.match(/t\.me\/([a-zA-Z0-9_]{4,})/)?.[1];

    tours.push({
      title,
      activity_type: detectActivity(title + ' ' + plain.slice(0, 200)),
      date_from: dates[0],
      date_to: dates[1],
      price,
      currency: 'RUB',
      contact_tg: tgLinks ? `https://t.me/${tgLinks}` : undefined,
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
  const operatorId = slot.operator_name ? await findOperatorId(slot.operator_name) : null;

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
  };

  let url = TOURS_URL;
  if (filter?.dateFrom) url += `?date_from=${filter.dateFrom}`;
  if (filter?.dateTo) url += `${url.includes('?') ? '&' : '?'}date_to=${filter.dateTo}`;

  let slots: TourSlot[] = [];

  if (firecrawlAvailable()) {
    const page = await firecrawlScrape(url);
    if (page?.markdown) slots = parseMarkdownTours(page.markdown);
  }

  if (slots.length === 0) {
    const html = await fetchPage(url);
    if (html) slots = parseHtmlTours(html);
  }

  if (slots.length === 0) {
    result.errors.push(`Не удалось получить туры с ${TOURS_URL}`);
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
