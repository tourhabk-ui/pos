/**
 * GET /api/cron/indexnow-content?since=YYYY-MM-DD — пинг IndexNow по текстам,
 * которые принёс выкат: посадочные, статьи, тонкие страницы мест и маршрутов,
 * рыбы, парки, планы (Сыщик 21.11). Адреса — из карты сайта, у которых lastmod
 * не раньше `since` (по умолчанию — двое суток назад). Подача — в Яндекс и Bing.
 *
 * Зовёт workflow indexnow-content.yml после того, как своя сборка поднялась на
 * проде; закрыт CRON_SECRET, как и indexnow-plans. Итог — в ai_actions_log.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pingIndexNow, contentUrlsChangedSince, parseSince, INDEXNOW_BING_ENDPOINT } from '@/lib/seo/indexnow';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';
import { LANDINGS } from '@/lib/landings/landings';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const since = parseSince(request.nextUrl.searchParams.get('since'));
  const { entries, degraded } = await collectSitemapEntriesWithStatus();
  const urls = contentUrlsChangedSince(entries, since, LANDINGS.map((l) => l.path));
  const [yandex, bing] = await Promise.all([
    pingIndexNow(urls, { source: 'indexnow-content' }),
    pingIndexNow(urls, { source: 'indexnow-content', endpoint: INDEXNOW_BING_ENDPOINT }),
  ]);
  const ok = yandex.ok && bing.ok;
  return NextResponse.json(
    {
      ok,
      probe: 'indexnow_content_v1',
      measured_at: new Date().toISOString(),
      since: since.toISOString(),
      submitted: urls.length,
      urls,
      // Разделы карты сайта, которые не прочитались: их адресов в подаче нет.
      degraded,
      yandex: { status: yandex.status ?? null, error: yandex.error ?? null },
      bing: { status: bing.status ?? null, error: bing.error ?? null },
    },
    { status: ok ? 200 : 502 },
  );
}
