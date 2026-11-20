/** RSS статей и посадочных (Сыщик 21.11) — lib/seo/rss.ts. */
import { feedXml } from '@/lib/seo/rss';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(await feedXml(getPublicBaseUrl()), {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=900, s-maxage=900',
    },
  });
}
