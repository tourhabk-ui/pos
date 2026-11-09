/**
 * GET /api/cron/indexnow-full — одна подача всего sitemap в IndexNow.
 *
 * После выката ключа на /<ключ>.txt. Список адресов — тот же сборщик, что
 * у sitemap.xml. Два приёмника: api.indexnow.org и yandex.com/indexnow.
 * Пачки до 10 000. Ответ называет HTTP-статус каждого, а не одно «ок».
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pingIndexNow } from '@/lib/seo/indexnow';
import { collectSitemapEntries } from '@/lib/seo/sitemap-entries';

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

  try {
    const entries = await collectSitemapEntries();
    const urls = entries.map((e) => e.url);
    const result = await pingIndexNow(urls, { source: 'indexnow-full' });
    return NextResponse.json(
      {
        ok: result.ok,
        submitted: result.submitted,
        status: result.status ?? null,
        error: result.error ?? null,
        endpoints: result.endpoints ?? [],
      },
      { status: result.ok ? 200 : 502 },
    );
  } catch (e) {
    console.error('[indexnow-full] sitemap не собран:', e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, submitted: 0, error: e instanceof Error ? e.message : 'sitemap не собран', endpoints: [] },
      { status: 500 },
    );
  }
}
