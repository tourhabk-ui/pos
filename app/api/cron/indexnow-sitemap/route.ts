/**
 * GET /api/cron/indexnow-sitemap — подача ВСЕЙ карты сайта в IndexNow под
 * CRON_SECRET (задача «Завести страницы Ведара в индекс», 19.11).
 *
 * Зачем. Замер 15.11: https-хост vedarai.ru в Вебмастере Яндекса —
 * HOST_NOT_LOADED, а в выдаче поисковиков всего четыре адреса сайта. Пинги
 * IndexNow до этого дня шли только попутно — тур, место, маршрут при
 * сохранении, планы и /zh после деплоя. Всю карту сайта (больше тысячи
 * адресов) подать было можно только через /api/admin/indexnow/bulk, а он
 * требует admin-JWT, и раннер его позвать не может. Звал ли его кто-то
 * руками, по коду не видно — это видно только в ai_actions_log. Яндекс — соавтор протокола; участники передают адреса друг
 * другу, Bing в их числе. Google в IndexNow не участвует: для него карта
 * сайта подаётся в Search Console владельцем.
 *
 * Адреса — те же, что отдаёт /sitemap.xml (collectSitemapEntriesWithStatus),
 * второго списка нет. В пинг идут только адреса нашего хоста: чужой хост в
 * списке IndexNow отвергает всю пачку (422).
 *
 * Исходы (§4.0):
 * - принято, карта полная — 200;
 * - карта неполная (секция не прочиталась) — то, что прочиталось, всё равно
 *   уходит, а ответ 502 называет секции: «подали всё» не выдаётся за правду;
 * - карта пуста — 502 без пинга: ноль адресов на входе — отказ, а не успех;
 * - IndexNow отверг или не ответил — 502 со словами протокола.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { MetadataRoute } from 'next';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pingIndexNow } from '@/lib/seo/indexnow';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** До 10 000 адресов за один POST по спецификации; столько же режет pingIndexNow. */
export const SITEMAP_PING_MAX = 5000;

/**
 * Адреса карты сайта для пинга: только хост `base`, без повторов, в порядке
 * карты. Возвращает и то, что отброшено, — чтобы ответ называл это числом.
 */
export function sitemapPingUrls(
  entries: MetadataRoute.Sitemap,
  base: string,
): { urls: string[]; foreign: number; truncated: number } {
  const host = new URL(base).host;
  const seen = new Set<string>();
  let foreign = 0;
  for (const e of entries) {
    let url: URL;
    try {
      url = new URL(e.url);
    } catch {
      foreign += 1;
      continue;
    }
    if (url.host !== host) {
      foreign += 1;
      continue;
    }
    seen.add(url.toString());
  }
  const all = [...seen];
  return {
    urls: all.slice(0, SITEMAP_PING_MAX),
    foreign,
    truncated: Math.max(0, all.length - SITEMAP_PING_MAX),
  };
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(getCronSecret(request), cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { entries, degraded } = await collectSitemapEntriesWithStatus();
  const { urls, foreign, truncated } = sitemapPingUrls(entries, getPublicBaseUrl());

  const base = {
    probe: 'indexnow_sitemap_v1',
    measured_at: new Date().toISOString(),
    sitemap_entries: entries.length,
    foreign_host_dropped: foreign,
    truncated,
    degraded_sections: degraded,
  };

  if (urls.length === 0) {
    return NextResponse.json(
      { ...base, ok: false, submitted: 0, error: 'карта сайта пуста — подавать нечего, это отказ, а не успех' },
      { status: 502 },
    );
  }

  const result = await pingIndexNow(urls, { source: 'indexnow-sitemap' });
  const ok = result.ok && degraded.length === 0 && truncated === 0;
  return NextResponse.json(
    {
      ...base,
      ok,
      submitted: result.submitted,
      // Первые адреса — глазами проверить, что ушёл нужный хост.
      sample: urls.slice(0, 10),
      status: result.status ?? null,
      error: result.error
        ?? (degraded.length > 0 ? `карта неполная: не прочитаны секции ${degraded.join(', ')}` : null)
        ?? (truncated > 0 ? `в один пинг не вошло ${truncated} адресов` : null),
    },
    { status: ok ? 200 : 502 },
  );
}
