/**
 * lib/services/visitkamchatka-audit.ts
 *
 * Аудит официального сайта visitkamchatka.ru — определяет структуру,
 * количество элементов и CSS-классы в каждом разделе.
 * Используется для планирования парсинга.
 */

import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const BASE = 'https://visitkamchatka.ru';
const UA = 'Mozilla/5.0 (compatible; TourHabBot/1.0)';

// Разделы сайта для аудита
const SECTIONS: { key: string; label: string; url: string; itemPattern: RegExp }[] = [
  {
    key: 'main',
    label: 'Главная страница',
    url: `${BASE}/`,
    itemPattern: /<a[^>]+href="\/([^"]+)"[^>]*>/gi,
  },
  {
    key: 'operators',
    label: 'Туроператоры',
    url: `${BASE}/tour-operators/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:company|operator|card|item|org|firm|agency)[^"]*"[^>]*>/gi,
  },
  {
    key: 'routes',
    label: 'Маршруты',
    url: `${BASE}/marshruty/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:route|marshrut|card|item|tour)[^"]*"[^>]*>/gi,
  },
  {
    key: 'places',
    label: 'Достопримечательности',
    url: `${BASE}/dostoprimechatelnosti/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:place|object|card|item|sight)[^"]*"[^>]*>/gi,
  },
  {
    key: 'tours',
    label: 'Туры',
    url: `${BASE}/tury/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:tour|card|item|product|package)[^"]*"[^>]*>/gi,
  },
  {
    key: 'excursions',
    label: 'Экскурсии',
    url: `${BASE}/ekskursii/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:excursion|ekskursi|card|item|tour)[^"]*"[^>]*>/gi,
  },
  {
    key: 'events',
    label: 'События',
    url: `${BASE}/events/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:event|card|item|news)[^"]*"[^>]*>/gi,
  },
  {
    key: 'news',
    label: 'Новости',
    url: `${BASE}/news/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:news|article|card|item|post)[^"]*"[^>]*>/gi,
  },
  {
    key: 'guides',
    label: 'Гиды',
    url: `${BASE}/guides/`,
    itemPattern: /<(?:div|article|li)[^>]*class="[^"]*(?:guide|person|card|item)[^"]*"[^>]*>/gi,
  },
];

export interface SectionAudit {
  key: string;
  label: string;
  url: string;
  status: 'ok' | '403' | '404' | 'timeout' | 'error' | 'empty';
  html_length: number;
  title: string | null;
  item_count: number;
  top_classes: string[];
  nav_links: string[];
  internal_links: { url: string; text: string }[];
  html_preview: string;
  pagination: { found: boolean; total_pages?: number; total_items?: number };
}

export interface SiteAuditResult {
  audited_at: string;
  base_url: string;
  sections: SectionAudit[];
  summary: {
    accessible_sections: number;
    total_items_found: number;
    discovered_paths: string[];
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function extractTopClasses(html: string, limit = 30): string[] {
  const all = Array.from(html.matchAll(/class="([^"]+)"/g))
    .flatMap(m => m[1].split(/\s+/))
    .filter(c => c.length > 2 && c.length < 50 && !/^(true|false|null)$/.test(c));

  const freq = new Map<string, number>();
  for (const c of all) freq.set(c, (freq.get(c) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cls, n]) => `${cls}(${n})`);
}

function extractNavLinks(html: string): string[] {
  const navSection = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? '';
  const links = new Set<string>();
  for (const m of navSection.matchAll(/href="(\/[^"?#]*?)"/g)) {
    links.add(m[1]);
  }
  return [...links].slice(0, 30);
}

function extractInternalLinks(html: string, currentPath: string): { url: string; text: string }[] {
  const links: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a[^>]+href="(\/[^"?#]{3,100})"[^>]*>([^<]{2,100})<\/a>/gi)) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (url !== currentPath && text && links.length < 40) {
      links.push({ url, text });
    }
  }
  // Deduplicate by URL
  const seen = new Set<string>();
  return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
}

function extractPagination(html: string): { found: boolean; total_pages?: number; total_items?: number } {
  // Try to find pagination info
  const paginationMatch = html.match(/страниц[а-яё]*[^0-9]*(\d+)\s*из\s*(\d+)/i) ??
    html.match(/page[^0-9]*(\d+)[^0-9]+of[^0-9]+(\d+)/i);
  if (paginationMatch) {
    return { found: true, total_pages: parseInt(paginationMatch[2], 10) };
  }

  // Total items hint
  const totalMatch = html.match(/(?:найдено|всего|total)[^0-9]*(\d+)/i);
  if (totalMatch) {
    return { found: false, total_items: parseInt(totalMatch[1], 10) };
  }

  // Check if pagination links exist
  const hasPagination = /class="[^"]*pag[^"]*"/.test(html) ||
    /class="[^"]*page-[^"]*"/.test(html) ||
    /href="[^"]*\?page=\d/.test(html) ||
    /href="[^"]*\/page\/\d/.test(html);

  return { found: hasPagination };
}

function countItems(html: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(html) !== null) count++;
  pattern.lastIndex = 0;
  return count;
}

// ── Audit a single section ────────────────────────────────────────────────────

async function auditSection(section: typeof SECTIONS[0]): Promise<SectionAudit> {
  const base: SectionAudit = {
    key: section.key,
    label: section.label,
    url: section.url,
    status: 'error',
    html_length: 0,
    title: null,
    item_count: 0,
    top_classes: [],
    nav_links: [],
    internal_links: [],
    html_preview: '',
    pagination: { found: false },
  };

  // Call Bright Data directly so we can capture non-2xx error body for diagnosis
  const token = process.env.BRIGHTDATA_API_TOKEN;
  let html: string | null = null;
  let bdErrorBody: string | null = null;
  let bdStatus: number | null = null;

  if (token) {
    try {
      const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
      const r = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone, url: section.url, format: 'raw' }),
        signal: AbortSignal.timeout(18_000),
      });
      bdStatus = r.status;
      if (r.ok) {
        const text = await r.text();
        html = text || null;
        if (!text) bdErrorBody = 'Bright Data вернул HTTP 200 с пустым телом — сайт блокирует запросы';
      } else {
        bdErrorBody = (await r.text().catch(() => '')).slice(0, 300);
      }
    } catch (e) {
      bdErrorBody = (e as Error).message;
    }
  } else {
    html = await fetchViaBrightData(section.url, { country: 'ru', timeoutMs: 30_000 });
  }

  if (!html) {
    base.status = bdStatus === 403 ? '403' : bdStatus === 404 ? '404' : 'error';
    // Store error info in html_preview so we can see it in the UI
    base.html_preview = bdErrorBody
      ? `Bright Data error (HTTP ${bdStatus}): ${bdErrorBody}`
      : `Bright Data returned null (HTTP ${bdStatus ?? 'no response'})`;
    return base;
  }

  base.html_length = html.length;
  base.status = html.length < 500 ? 'empty' : 'ok';
  base.title = extractTitle(html);
  base.item_count = countItems(html, section.itemPattern);
  base.top_classes = extractTopClasses(html, 25);
  base.nav_links = extractNavLinks(html);
  base.internal_links = extractInternalLinks(html, new URL(section.url).pathname);
  base.html_preview = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .slice(0, 4000);
  base.pagination = extractPagination(html);

  // Special case for main page: discover all internal section links
  if (section.key === 'main') {
    const sectionLinks = new Set<string>();
    for (const m of html.matchAll(/href="(\/[a-zA-Z][a-zA-Z0-9_-]{2,50}\/?)"/g)) {
      sectionLinks.add(m[1]);
    }
    base.internal_links = [...sectionLinks]
      .filter(u => !u.startsWith('/wp-') && !u.startsWith('/static'))
      .slice(0, 50)
      .map(u => ({ url: u, text: '' }));
  }

  return base;
}

// ── Main audit function ───────────────────────────────────────────────────────

export async function auditVisitKamchatka(): Promise<SiteAuditResult> {
  // Hard deadline: always resolve within 25s so the HTTP response never gets cut off
  const deadline = new Promise<SectionAudit[]>(resolve =>
    setTimeout(() => resolve(SECTIONS.map(s => ({
      key: s.key, label: s.label, url: s.url,
      status: 'timeout' as const, html_length: 0, title: null, item_count: 0,
      top_classes: [], nav_links: [], internal_links: [],
      html_preview: 'Global timeout — секция не успела ответить за 25с',
      pagination: { found: false },
    }))), 25_000)
  );

  // Run all sections in parallel — going through Bright Data so site rate-limiting is not a concern
  const results = await Promise.race([
    Promise.all(SECTIONS.map(auditSection)),
    deadline,
  ]);

  const accessibleSections = results.filter(r => r.status === 'ok').length;
  const totalItems = results.reduce((sum, r) => sum + r.item_count, 0);

  // Collect unique discovered paths from main page
  const mainAudit = results.find(r => r.key === 'main');
  const discoveredPaths = mainAudit?.internal_links.map(l => l.url) ?? [];

  return {
    audited_at: new Date().toISOString(),
    base_url: BASE,
    sections: results,
    summary: {
      accessible_sections: accessibleSections,
      total_items_found: totalItems,
      discovered_paths: discoveredPaths,
    },
  };
}
