/**
 * GET /api/cron/indexnow-plans — пинг IndexNow по страницам готовых планов.
 *
 * Зачем отдельно от bulk-подачи (/api/admin/indexnow/bulk): та требует
 * admin-JWT и шлёт весь sitemap; здесь — только /plans и /plans/[slug],
 * под CRON_SECRET, чтобы раннер мог позвать его после деплоя правок текстов
 * (18.09: хаб переписан под запрос «Камчатка туры план»). Яндекс — соавтор
 * протокола: пинг доводит изменённую страницу до переобхода за минуты, а
 * плановый обход при changefreq weekly — за дни.
 *
 * Список адресов — из PLAN_PRESETS, того же источника, что у роута и sitemap.
 * Три исхода: принято (ok), отвергнуто (статус и текст IndexNow), не смог
 * (сетевой отказ) — все три в ответе, а не «пусто = хорошо» (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pingIndexNow } from '@/lib/seo/indexnow';
import { PLAN_PRESETS } from '@/lib/plans/presets';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Адреса планов — хаб и каждая страница пресета. */
export function planUrls(base: string): string[] {
  const root = base.replace(/\/$/, '');
  return [`${root}/plans`, ...PLAN_PRESETS.map((p) => `${root}/plans/${p.slug}`)];
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const urls = planUrls(getPublicBaseUrl());
  const result = await pingIndexNow(urls);
  return NextResponse.json(
    {
      ok: result.ok,
      probe: 'indexnow_plans_v1',
      measured_at: new Date().toISOString(),
      submitted: result.submitted,
      urls,
      // Отказ IndexNow — словами протокола, не догадкой.
      status: result.status ?? null,
      error: result.error ?? null,
    },
    { status: result.ok ? 200 : 502 },
  );
}
