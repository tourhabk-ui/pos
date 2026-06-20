/**
 * lib/services/visitkamchatka-operators.ts
 *
 * Парсинг официального каталога туроператоров Камчатки:
 *   https://visitkamchatka.ru/tour-operators/
 *
 * Извлекает: название, телефон, email, сайт, ссылки на Telegram.
 * Сохраняет в таблицу partners с external_source='visitkamchatka'.
 *
 * Запускается через POST /api/admin/import/operators
 */

import { pool } from '@/lib/db-pool';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const OPERATORS_URL = 'https://visitkamchatka.ru/tour-operators/';
const USER_AGENT = 'TourHab/1.0 (KamchatourHub operator importer)';
const FETCH_TIMEOUT = 15_000;

export interface OperatorRecord {
  name: string;
  slug: string;
  phone?: string;
  email?: string;
  website?: string;
  telegram_group_url?: string;
  license_number?: string;
  rating?: number;
  services?: string[];
  external_id?: string;
  external_source_url: string;
  description?: string;
}

export interface OperatorImportResult {
  total: number;
  inserted: number;
  updated: number;
  errors: string[];
  operators: { name: string; status: string; tg?: string }[];
}

// ── HTML fetch fallback ───────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

// ── Извлечение Telegram-ссылок из произвольного текста/HTML ──────────────────

function extractTgLinks(text: string): string[] {
  const links: string[] = [];
  const re = /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{4,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const username = m[1];
    // Исключаем служебные t.me пути
    if (['share', 'addstickers', 'joinchat', 'proxy', 'socks', 'iv'].includes(username)) continue;
    links.push(`https://t.me/${username}`);
  }
  return [...new Set(links)];
}

// ── Нормализация телефона ─────────────────────────────────────────────────────

function extractPhone(text: string): string | undefined {
  const m = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  return m ? m[0].replace(/\s/g, '') : undefined;
}

function extractEmail(text: string): string | undefined {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : undefined;
}

function toSlug(name: string): string {
  return 'vk-op-' + name
    .toLowerCase()
    .replace(/[а-яёА-ЯЁ]/g, c => {
      const map: Record<string, string> = {
        а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',
        и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',
        с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',
        ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
      };
      return map[c] ?? c;
    })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ── Парсинг markdown (Firecrawl output) ──────────────────────────────────────

function parseMarkdownOperators(markdown: string): OperatorRecord[] {
  const records: OperatorRecord[] = [];

  // Разбиваем по карточкам операторов:
  // каждая карточка обычно начинается с заголовка ## Название
  const sections = markdown.split(/\n(?=#{1,3}\s)/);

  for (const section of sections) {
    const titleMatch = section.match(/^#{1,3}\s+(.+)/m);
    if (!titleMatch) continue;
    const name = titleMatch[1].trim().replace(/\*+/g, '').trim();
    if (name.length < 3 || name.length > 150) continue;
    // Пропускаем системные заголовки страницы
    if (/туроператор|каталог|главная|навигация|меню/i.test(name)) continue;

    const phone = extractPhone(section);
    const email = extractEmail(section);
    const tgLinks = extractTgLinks(section);

    // Сайт из markdown ссылок [текст](url)
    const siteMatch = section.match(/\[(?:сайт|website|www|официальный)[^\]]*\]\(([^)]+)\)/i)
      ?? section.match(/https?:\/\/(?!t\.me|visitkamchatka)[\w\-]+\.[\w.\/]+/);
    const website = siteMatch ? (siteMatch[1] ?? siteMatch[0]) : undefined;

    // Определяем тип услуг из текста
    const services: string[] = [];
    if (/вулкан/i.test(section)) services.push('volcano');
    if (/рыбал/i.test(section)) services.push('fishing');
    if (/вертол/i.test(section)) services.push('helicopter');
    if (/морск|катер|лодк/i.test(section)) services.push('boat');
    if (/поход|трекинг|пеш/i.test(section)) services.push('trekking');
    if (/снегоход/i.test(section)) services.push('snowmobile');
    if (/сплав|рафт/i.test(section)) services.push('rafting');
    if (/медвед/i.test(section)) services.push('bears');

    // Лицензия
    const licenseMatch = section.match(/(?:лиценз|свидетельство|рег\.?\s*№|реестр)[^\n]*(\d[\d\-/А-Яа-я]{4,20})/i);

    const descMatch = section.match(/(?:\n|^)([А-ЯЁA-Z].{50,300})/m);

    records.push({
      name,
      slug: toSlug(name),
      phone,
      email,
      website,
      telegram_group_url: tgLinks[0],
      license_number: licenseMatch?.[1],
      services: services.length > 0 ? services : undefined,
      external_source_url: OPERATORS_URL,
      description: descMatch?.[1]?.slice(0, 400),
    });
  }

  return records;
}

// ── Парсинг raw HTML (fallback) ───────────────────────────────────────────────

function parseHtmlOperators(html: string): OperatorRecord[] {
  const records: OperatorRecord[] = [];

  // Ищем блоки карточек (div с классом типа company, operator, card)
  const cardRe = /<(?:div|article|section)[^>]*class="[^"]*(?:company|operator|partner|card|item)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|section)>/gi;
  let m: RegExpExecArray | null;

  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1];

    // Название из h2/h3/h4 или сильного тега
    const nameMatch = block.match(/<(?:h[2-4]|strong)[^>]*>([^<]{3,100})<\/(?:h[2-4]|strong)>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    if (name.length < 3) continue;

    const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const tgLinks = extractTgLinks(block);
    const siteMatch = block.match(/href="(https?:\/\/(?!visitkamchatka)[^"]+)"/i);

    records.push({
      name,
      slug: toSlug(name),
      phone: extractPhone(text),
      email: extractEmail(text),
      website: siteMatch?.[1],
      telegram_group_url: tgLinks[0],
      external_source_url: OPERATORS_URL,
    });
  }

  // Если карточки не найдены, пробуем извлечь ссылки с названиями
  if (records.length === 0) {
    const linkRe = /<a[^>]+href="([^"]*\/tour-operators\/[^"]+)"[^>]*>([^<]{5,100})<\/a>/gi;
    while ((m = linkRe.exec(html)) !== null) {
      const name = m[2].trim();
      if (name.length > 3 && !records.find(r => r.name === name)) {
        records.push({
          name,
          slug: toSlug(name),
          external_source_url: `https://visitkamchatka.ru${m[1]}`,
        });
      }
    }
  }

  return records;
}

// ── Поиск TG-группы на сайте оператора ───────────────────────────────────────

async function findTgOnWebsite(website: string): Promise<string | undefined> {
  try {
    const html = await fetchHtml(website);
    if (!html) return undefined;
    const links = extractTgLinks(html);
    return links[0];
  } catch {
    return undefined;
  }
}

// ── Upsert в partners ─────────────────────────────────────────────────────────

async function upsertOperator(op: OperatorRecord): Promise<'inserted' | 'updated' | 'skip'> {
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM partners WHERE slug = $1 OR (external_source = 'visitkamchatka' AND company_name = $2) LIMIT 1`,
    [op.slug, op.name],
  );

  if (existing.length > 0) {
    await pool.query(
      `UPDATE partners SET
         company_name       = COALESCE(NULLIF($2,''), company_name),
         external_source    = 'visitkamchatka',
         external_source_url= $3,
         website            = COALESCE($4, website),
         telegram_group_url = COALESCE($5, telegram_group_url),
         license_number     = COALESCE($6, license_number),
         services           = COALESCE($7, services),
         external_rating    = COALESCE($8, external_rating),
         updated_at         = NOW()
       WHERE id = $1`,
      [
        existing[0].id,
        op.name,
        op.external_source_url,
        op.website ?? null,
        op.telegram_group_url ?? null,
        op.license_number ?? null,
        op.services ? JSON.stringify(op.services) : null,
        op.rating ?? null,
      ],
    );
    return 'updated';
  }

  await pool.query(
    `INSERT INTO partners (
       slug, company_name, name,
       external_source, external_source_url, external_id,
       website, telegram_group_url, license_number, services, external_rating,
       is_verified, is_public, commission_current
     ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,0)
     ON CONFLICT (slug) DO UPDATE SET
       external_source     = EXCLUDED.external_source,
       external_source_url = EXCLUDED.external_source_url,
       website             = COALESCE(EXCLUDED.website, partners.website),
       telegram_group_url  = COALESCE(EXCLUDED.telegram_group_url, partners.telegram_group_url),
       updated_at          = NOW()`,
    [
      op.slug,
      op.name,
      'visitkamchatka',
      op.external_source_url,
      op.external_id ?? null,
      op.website ?? null,
      op.telegram_group_url ?? null,
      op.license_number ?? null,
      op.services ? `{${op.services.join(',')}}` : null,
      op.rating ?? null,
    ],
  );
  return 'inserted';
}

// ── Главная функция ───────────────────────────────────────────────────────────

export async function scrapeOperatorDirectory(): Promise<OperatorImportResult> {
  const result: OperatorImportResult = {
    total: 0,
    inserted: 0,
    updated: 0,
    errors: [],
    operators: [],
  };

  let rawRecords: OperatorRecord[] = [];

  // Попытка 1: Bright Data (обходит антибот, рендерит JS)
  const bdHtml = await fetchViaBrightData(OPERATORS_URL, { country: 'ru', timeoutMs: 30_000 });
  if (bdHtml) {
    rawRecords = parseHtmlOperators(bdHtml);
  }

  // Попытка 2: прямой fetch fallback
  if (rawRecords.length === 0) {
    const html = await fetchHtml(OPERATORS_URL);
    if (html) {
      rawRecords = parseHtmlOperators(html);
    }
  }

  if (rawRecords.length === 0) {
    result.errors.push('Не удалось получить список операторов с visitkamchatka.ru');
    return result;
  }

  // Для операторов без TG — ищем на их сайте (ограничиваем до 10 параллельных запросов)
  const withoutTg = rawRecords.filter(op => !op.telegram_group_url && op.website);
  const tgChunks = withoutTg.slice(0, 10);
  const tgResults = await Promise.allSettled(
    tgChunks.map(op => findTgOnWebsite(op.website!).then(tg => ({ op, tg }))),
  );
  for (const r of tgResults) {
    if (r.status === 'fulfilled' && r.value.tg) {
      const target = rawRecords.find(o => o.slug === r.value.op.slug);
      if (target) target.telegram_group_url = r.value.tg;
    }
  }

  result.total = rawRecords.length;

  // Сохраняем в БД
  for (const op of rawRecords) {
    try {
      const status = await upsertOperator(op);
      if (status === 'inserted') result.inserted++;
      else result.updated++;
      result.operators.push({ name: op.name, status, tg: op.telegram_group_url });
    } catch (e) {
      result.errors.push(`${op.name}: ${(e as Error).message}`);
    }
  }

  return result;
}
