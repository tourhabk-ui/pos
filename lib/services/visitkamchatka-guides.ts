/**
 * lib/services/visitkamchatka-guides.ts
 *
 * Парсинг аттестованных гидов Камчатки:
 *   https://visitkamchatka.ru/guides/
 *
 * Сохраняет в:
 *   partners (category='guide', external_source='visitkamchatka')
 *   guide_certifications (аттестат Министерства туризма)
 *
 * Запускается через POST /api/admin/import/operators { action: "scrape_guides" }
 */

import { pool } from '@/lib/db-pool';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const GUIDES_URL = 'https://visitkamchatka.ru/guides/';
const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

export interface GuideRecord {
  name: string;
  slug: string;
  phone?: string;
  email?: string;
  cert_number?: string;
  specializations?: string[];
  description?: string;
  external_source_url: string;
}

export interface GuidesImportResult {
  total: number;
  inserted: number;
  updated: number;
  errors: string[];
  guides: { name: string; status: string; cert?: string }[];
  debug?: { html_length: number; guide_links: number; strategy: string };
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchDirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function smartFetch(url: string): Promise<string | null> {
  const bd = await fetchViaBrightData(url, { country: 'ru', timeoutMs: 30_000 });
  if (bd) return bd;
  return fetchDirect(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPhone(text: string): string | undefined {
  const m = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  return m ? m[0].replace(/\s/g, '') : undefined;
}

function extractEmail(text: string): string | undefined {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : undefined;
}

function extractCertNumber(text: string): string | undefined {
  const m = text.match(/(?:аттест|свидетельство|сертификат|удостоверение|лиценз|рег\.?\s*№)[^\n]{0,60}((?:№\s*)?[\dА-Яа-я][\d\-/А-Яа-я]{3,30})/i);
  return m ? m[1].trim() : undefined;
}

function extractSpecializations(text: string): string[] {
  const specs: string[] = [];
  if (/вулкан/i.test(text))            specs.push('volcano');
  if (/трекинг|поход|пеш/i.test(text)) specs.push('trekking');
  if (/рыбал/i.test(text))             specs.push('fishing');
  if (/вертол/i.test(text))            specs.push('helicopter');
  if (/морск|катер/i.test(text))       specs.push('boat');
  if (/снегоход/i.test(text))          specs.push('snowmobile');
  if (/сплав|рафт/i.test(text))        specs.push('rafting');
  if (/медвед/i.test(text))            specs.push('bears');
  if (/фото/i.test(text))              specs.push('photo');
  if (/орнитол|птиц/i.test(text))      specs.push('birds');
  return specs;
}

function toSlug(name: string): string {
  const MAP: Record<string, string> = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',
    и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',
    с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  return 'vk-guide-' + name.toLowerCase()
    .replace(/[а-яёА-ЯЁ]/g, c => MAP[c.toLowerCase()] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}

// ── Парсинг HTML ──────────────────────────────────────────────────────────────

function extractGuideLinks(html: string): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="(https?:\/\/visitkamchatka\.ru\/guides\/[^"#?]{3,100})"/gi)) {
    const url = m[1].replace(/\/$/, '') + '/';
    if (url !== GUIDES_URL) links.add(url);
  }
  // Также относительные ссылки
  for (const m of html.matchAll(/href="(\/guides\/[^"#?]{3,100})"/gi)) {
    const url = `https://visitkamchatka.ru${m[1].replace(/\/$/, '')}/`;
    if (url !== GUIDES_URL) links.add(url);
  }
  return [...links];
}

function parseGuideFromHtml(html: string, url: string): GuideRecord | null {
  // Заголовок страницы гида
  const h1Match = html.match(/<h1[^>]*>([^<]{3,150})<\/h1>/i);
  if (!h1Match) return null;
  const name = h1Match[1].replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 3) return null;

  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Описание — ищем первый длинный абзац
  const pMatch = html.match(/<p[^>]*>([^<]{80,600})<\/p>/i);
  const description = pMatch ? pMatch[1].replace(/&[^;]+;/g, ' ').trim().slice(0, 500) : undefined;

  return {
    name,
    slug: toSlug(name),
    phone: extractPhone(text),
    email: extractEmail(text),
    cert_number: extractCertNumber(text),
    specializations: extractSpecializations(text),
    description,
    external_source_url: url,
  };
}

function parseGuideCards(html: string): GuideRecord[] {
  const records: GuideRecord[] = [];

  // Стратегия 1: карточки по CSS-классам гидов
  const cardRe = /<(?:div|article|li)[^>]*class="[^"]*(?:guide|person|card|item)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article|li)>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1];
    const nameMatch = block.match(/<(?:h[1-4]|strong|b)[^>]*>([^<]{3,100})<\/(?:h[1-4]|strong|b)>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length < 3 || name.length > 150) continue;
    const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const urlMatch = block.match(/href="([^"]*\/guides\/[^"#?]{3,}[^"/])"/i);
    const sourceUrl = urlMatch ? `https://visitkamchatka.ru${urlMatch[1].startsWith('/') ? '' : '/'}${urlMatch[1]}` : GUIDES_URL;
    if (!records.find(r => r.name === name)) {
      records.push({
        name, slug: toSlug(name),
        phone: extractPhone(text), email: extractEmail(text),
        cert_number: extractCertNumber(text),
        specializations: extractSpecializations(text),
        external_source_url: sourceUrl,
      });
    }
  }

  // Стратегия 2: ссылки на подстраницы /guides/...
  if (records.length === 0) {
    const linkRe = /<a[^>]+href="([^"]*\/guides\/[^"#?]{3,})"[^>]*>([^<]{3,100})<\/a>/gi;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1].startsWith('http') ? m[1] : `https://visitkamchatka.ru${m[1]}`;
      const name = m[2].trim().replace(/&[^;]+;/g, '').replace(/\s+/g, ' ');
      if (name.length > 3 && !records.find(r => r.name === name)) {
        records.push({ name, slug: toSlug(name), external_source_url: href });
      }
    }
  }

  return records;
}

// ── DB upsert ─────────────────────────────────────────────────────────────────

async function upsertGuide(guide: GuideRecord): Promise<{ status: 'inserted' | 'updated' | 'skip'; id: string | null }> {
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM partners WHERE slug = $1 OR (external_source = 'visitkamchatka' AND company_name = $2 AND category = 'guide') LIMIT 1`,
    [guide.slug, guide.name],
  );

  const contactJson = JSON.stringify({
    phone: guide.phone ?? null,
    email: guide.email ?? null,
  });

  if (existing.length > 0) {
    const id = existing[0].id;
    await pool.query(
      `UPDATE partners SET
         company_name        = COALESCE(NULLIF($2,''), company_name),
         contact             = $3::jsonb,
         external_source     = 'visitkamchatka',
         external_source_url = $4,
         description         = COALESCE(NULLIF($5,''), description),
         services            = COALESCE($6, services),
         updated_at          = NOW()
       WHERE id = $1`,
      [
        id, guide.name, contactJson, guide.external_source_url,
        guide.description ?? null,
        guide.specializations?.length ? `{${guide.specializations.join(',')}}` : null,
      ],
    );
    return { status: 'updated', id };
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO partners (
       slug, company_name, name, category, contact,
       external_source, external_source_url,
       description, services,
       is_verified, is_public, commission_current
     ) VALUES ($1,$2,$2,'guide',$3::jsonb,'visitkamchatka',$4,$5,$6,false,false,0)
     ON CONFLICT (slug) DO UPDATE SET
       company_name        = EXCLUDED.company_name,
       contact             = EXCLUDED.contact,
       external_source_url = EXCLUDED.external_source_url,
       description         = COALESCE(EXCLUDED.description, partners.description),
       updated_at          = NOW()
     RETURNING id`,
    [
      guide.slug, guide.name, contactJson, guide.external_source_url,
      guide.description ?? null,
      guide.specializations?.length ? `{${guide.specializations.join(',')}}` : null,
    ],
  );
  return { status: 'inserted', id: rows[0]?.id ?? null };
}

async function upsertCertification(guideId: string, certNumber: string): Promise<void> {
  await pool.query(
    `INSERT INTO guide_certifications (guide_id, name, issuing_authority, certificate_number, is_verified)
     VALUES ($1, 'Аттестат гида Камчатки', 'Министерство туризма Камчатского края', $2, true)
     ON CONFLICT DO NOTHING`,
    [guideId, certNumber],
  );
}

// ── Главная функция ───────────────────────────────────────────────────────────

export async function scrapeGuideDirectory(): Promise<GuidesImportResult> {
  const result: GuidesImportResult = {
    total: 0, inserted: 0, updated: 0,
    errors: [], guides: [],
    debug: { html_length: 0, guide_links: 0, strategy: '' },
  };

  const listingHtml = await smartFetch(GUIDES_URL);
  if (!listingHtml) {
    result.errors.push('Не удалось получить HTML с visitkamchatka.ru/guides/ (403 или нет Bright Data)');
    return result;
  }

  result.debug!.html_length = listingHtml.length;

  // Ищем ссылки на индивидуальные страницы
  const guideLinks = extractGuideLinks(listingHtml);
  result.debug!.guide_links = guideLinks.length;

  let rawRecords: GuideRecord[] = [];

  if (guideLinks.length > 0) {
    result.debug!.strategy = `individual_pages(${guideLinks.length})`;
    for (const url of guideLinks) {
      const html = await smartFetch(url);
      if (!html) continue;
      const guide = parseGuideFromHtml(html, url);
      if (guide) rawRecords.push(guide);
      await sleep(600 + Math.random() * 400);
    }
  } else {
    result.debug!.strategy = 'listing_cards';
    rawRecords = parseGuideCards(listingHtml);
  }

  if (rawRecords.length === 0) {
    result.errors.push(
      `HTML получен (${listingHtml.length} байт), но парсер не нашёл гидов. ` +
      `Ссылок /guides/ на странице: ${guideLinks.length}`,
    );
    return result;
  }

  result.total = rawRecords.length;

  for (const guide of rawRecords) {
    try {
      const { status, id } = await upsertGuide(guide);
      if (status === 'inserted') result.inserted++;
      else if (status === 'updated') result.updated++;
      if (id && guide.cert_number) await upsertCertification(id, guide.cert_number);
      result.guides.push({ name: guide.name, status, cert: guide.cert_number });
    } catch (e) {
      result.errors.push(`${guide.name}: ${(e as Error).message}`);
    }
  }

  return result;
}
