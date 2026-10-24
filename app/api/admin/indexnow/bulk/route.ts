/**
 * POST /api/admin/indexnow/bulk — первичная подача всех страниц в IndexNow.
 *
 * Разовая операция: сообщает IndexNow (Bing) и Яндексу обо всём содержимом
 * сразу, дальше работают попутные пинги при изменениях (lib/seo/indexnow.ts).
 * Тот же список с раннера после выкладки — GET /api/cron/indexnow-full.
 *
 * Список адресов — тот же sitemap, не вторая рука: две руки, составляющие
 * один список, рано или поздно расходятся.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pingIndexNow } from '@/lib/seo/indexnow';
import { collectSitemapEntries } from '@/lib/seo/sitemap-entries';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const entries = await collectSitemapEntries();
    const urls = entries.map((e) => e.url);
    const result = await pingIndexNow(urls);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Ошибка подачи' },
      { status: 500 },
    );
  }
}
