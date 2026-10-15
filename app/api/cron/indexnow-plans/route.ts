/**
 * GET /api/cron/indexnow-plans — пинг IndexNow по страницам, которые меняет
 * деплой, а не запись в базу: готовые планы и китайский раздел /zh.
 *
 * Зачем отдельно от bulk-подачи (/api/admin/indexnow/bulk): та требует
 * admin-JWT и шлёт весь sitemap; здесь — короткий список под CRON_SECRET,
 * чтобы раннер мог позвать его после деплоя правок текстов (18.09: хаб
 * /plans переписан под запрос «Камчатка туры план»). Яндекс — соавтор
 * протокола: пинг доводит изменённую страницу до переобхода за минуты, а
 * плановый обход при changefreq weekly — за дни.
 *
 * С аудита 15.10 (CN-quick) — и китайские страницы: у /zh пути IndexNow не
 * было вовсе (bulk только под admin-JWT, остальные пинги — туры, места,
 * маршруты). Участники IndexNow передают адреса друг другу по протоколу,
 * Bing в их числе; Baidu в IndexNow не участвует — для него нужен аккаунт
 * владельца (docs/agents/CHINA.md, шаг 4). Дошёл ли пинг до Bing, видно
 * только в его вебмастере; итог отправки — в ai_actions_log (indexnow_ping /
 * indexnow_failed с адресами и source).
 *
 * Списки адресов — из PLAN_PRESETS и lib/zh/pages, тех же источников, что у
 * роутов и sitemap. Три исхода: принято (ok), отвергнуто (статус и текст
 * IndexNow), не смог (сетевой отказ) — все три в ответе, а не «пусто =
 * хорошо» (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pingIndexNow } from '@/lib/seo/indexnow';
import { PLAN_PRESETS } from '@/lib/plans/presets';
import { zhPageUrls } from '@/lib/zh/pages';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Адреса планов — хаб и каждая страница пресета. */
export function planUrls(base: string): string[] {
  const root = base.replace(/\/$/, '');
  return [`${root}/plans`, ...PLAN_PRESETS.map((p) => `${root}/plans/${p.slug}`)];
}

/** Всё, что пингует роут: планы и китайские страницы, без повторов. */
export function deployPageUrls(base: string): { plans: string[]; zh: string[]; all: string[] } {
  const plans = planUrls(base);
  const zh = zhPageUrls(base);
  return { plans, zh, all: [...new Set([...plans, ...zh])] };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { plans, zh, all } = deployPageUrls(getPublicBaseUrl());
  const result = await pingIndexNow(all, { source: 'indexnow-plans' });
  return NextResponse.json(
    {
      ok: result.ok,
      probe: 'indexnow_plans_v2',
      measured_at: new Date().toISOString(),
      submitted: result.submitted,
      urls: all,
      // Сколько адресов из какого списка — чтобы «пинговался ли /zh» читалось из ответа.
      groups: { plans: plans.length, zh: zh.length },
      // Отказ IndexNow — словами протокола, не догадкой.
      status: result.status ?? null,
      error: result.error ?? null,
    },
    { status: result.ok ? 200 : 502 },
  );
}
