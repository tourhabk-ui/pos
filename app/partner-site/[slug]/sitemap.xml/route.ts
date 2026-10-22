/**
 * sitemap.xml сайта партнёра на его домене: одна страница — главная.
 * Без него /sitemap.xml на домене партнёра отдал бы карту Ведара.
 */
import { partnerSiteBySlug, partnerSiteUrl } from '@/lib/partner-sites/registry';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const site = partnerSiteBySlug((await params).slug);
  if (!site) return new Response('Not found', { status: 404 });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${partnerSiteUrl(site)}</loc></url>`,
    '</urlset>',
    '',
  ].join('\n');
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
