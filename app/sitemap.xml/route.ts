/**
 * GET /sitemap.xml — runtime-генерация.
 *
 * Раньше sitemap был метадата-роутом (app/sitemap.ts), и Next пререндерил
 * его на сборке — а на Timeweb-сборке БД недоступна по построению: все
 * динамические секции (туры, места, маршруты) молча пустели, и обходчики
 * никогда не видели ни одной карточки тура (аудит 08.08). Route-handler
 * с force-dynamic исполняется на запросе — тот же паттерн, что /llms.txt.
 * Кэш на CDN-стороне — час: sitemap не обязан быть посекундно свежим.
 */

import { NextResponse } from 'next/server';
import { collectSitemapEntries } from '@/lib/seo/sitemap-entries';

export const dynamic = 'force-dynamic';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isoDate(d: string | Date | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export async function GET() {
  const entries = await collectSitemapEntries();

  const urls = entries.map((e) => {
    const lastmod = isoDate(e.lastModified);
    return [
      '  <url>',
      `    <loc>${xmlEscape(e.url)}</loc>`,
      lastmod ? `    <lastmod>${lastmod}</lastmod>` : '',
      e.changeFrequency ? `    <changefreq>${e.changeFrequency}</changefreq>` : '',
      e.priority != null ? `    <priority>${e.priority}</priority>` : '',
      '  </url>',
    ].filter(Boolean).join('\n');
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
  ].join('\n');

  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
