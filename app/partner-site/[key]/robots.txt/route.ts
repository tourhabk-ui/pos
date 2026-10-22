/**
 * robots.txt сайта партнёра на его домене (next.config.js переписывает сюда
 * /robots.txt с fishingkam.ru). Без него домен партнёра отдавал бы robots
 * Ведара — со ссылкой на sitemap vedarai.ru. Правила — lib/partner-sites/seo.
 */
import { partnerSiteByKey, partnerSiteUrl } from '@/lib/partner-sites/registry';
import { partnerRobots } from '@/lib/partner-sites/seo';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const site = partnerSiteByKey((await params).key);
  if (!site) return new Response('Not found', { status: 404 });
  return new Response(partnerRobots(partnerSiteUrl(site, '/sitemap.xml')), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
