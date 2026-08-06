/**
 * POST /api/admin/indexnow/bulk — первичная подача всех страниц в IndexNow.
 *
 * Разовая операция после включения протокола: сообщает Яндексу обо всём
 * содержимом сразу (779 мест, маршруты, туры, каталоги), дальше работают
 * попутные пинги при изменениях (lib/seo/indexnow.ts).
 *
 * Список адресов — тот же sitemap, не вторая рука: две руки, составляющие
 * один список, рано или поздно расходятся.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pingIndexNow } from '@/lib/seo/indexnow';
import sitemap from '@/app/sitemap';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const entries = await sitemap();
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
