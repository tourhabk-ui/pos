/**
 * Расширенная статистика визитов: откуда пришли, где вошли, с какого
 * устройства. Владелец 21.10: «круто бы при нажатии на количество визитов
 * открывалась бы расширенная статистика».
 *
 * Единица — тот же суточный visitor_hash, что у «Визитов» воронки, и те же
 * исключения (краулеры, свои заходы). Источник и страница входа — по ПЕРВОМУ
 * просмотру человека в окне: так каждый визит попадает ровно в одну строку,
 * и сумма по источникам равна числу визитов.
 *
 * Новых персональных данных нет: referrer и путь писались и раньше, устройство
 * — только класс (mobile / tablet / desktop) из UA, сам UA не хранится.
 */
import { pool } from '@/lib/db-pool';
import { AI_FAMILY_NAMES, isOwnReferrer } from '@/lib/analytics/bot-detect';
import { WINDOW_SQL, windowParams, measure, type FunnelWindow, type FunnelExecutor } from '@/lib/analytics/funnel-window';

export type Device = 'mobile' | 'tablet' | 'desktop';

/** Класс устройства по User-Agent. Пустой UA — null, а не «компьютер». */
export function deviceClass(userAgent: string | null | undefined): Device | null {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua) return null;
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone|opera mini/.test(ua)) return 'mobile';
  return 'desktop';
}

export type SourceGroup = 'search' | 'ai' | 'messenger' | 'social' | 'direct' | 'internal' | 'other';

export const SOURCE_GROUP_LABEL: Record<SourceGroup, string> = {
  search: 'Поисковики',
  ai: 'Нейросети',
  messenger: 'Telegram и MAX',
  social: 'Соцсети',
  direct: 'Напрямую',
  internal: 'Внутри сайта',
  other: 'Другие сайты',
};

const SEARCH = ['yandex.', 'ya.ru', 'google.', 'bing.com', 'duckduckgo.com', 'mail.ru', 'rambler.ru', 'yahoo.', 'ecosia.org', 'baidu.com'];
const AI = ['chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'chat.deepseek.com', 'deepseek.com', 'alice.yandex.ru', 'giga.chat', 'gigachat', 'grok.com',
  'you.com', 'phind.com', 'poe.com', 'chat.mistral.ai', 'meta.ai', 'kimi.', 'qwen'];
const MESSENGER = ['t.me', 'telegram.org', 'telegram.me', 'max.ru', 'web.max.ru', 'oneme.ru', 'whatsapp.com', 'wa.me'];
const SOCIAL = ['vk.com', 'vk.ru', 'ok.ru', 'dzen.ru', 'zen.yandex.ru', 'instagram.com', 'facebook.com', 'youtube.com', 'tiktok.com', 'pinterest.', 'x.com', 't.co', 'reddit.com'];

export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(referrer.trim());
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
}

const hit = (host: string, list: string[]) =>
  list.some((d) => (d.endsWith('.') ? host.startsWith(d) || host.includes(`.${d}`) : host === d || host.endsWith(`.${d}`) || (!d.includes('.') && host.includes(d))));

/** Группа источника по хосту реферера. ИИ проверяется раньше поиска: gemini.google.com — не поиск. */
export function sourceGroup(host: string | null): SourceGroup {
  if (!host) return 'direct';
  // Свои домены — тот же список, что у счётчика переходов (bot-detect).
  if (isOwnReferrer(`https://${host}/`)) return 'internal';
  if (hit(host, AI)) return 'ai';
  if (hit(host, MESSENGER)) return 'messenger';
  if (hit(host, SEARCH)) return 'search';
  if (hit(host, SOCIAL)) return 'social';
  return 'other';
}

export interface VisitBreakdown {
  visits: number | null;
  sources: Array<{ group: SourceGroup; label: string; visits: number; hosts: Array<{ host: string; visits: number }> }> | null;
  landing: Array<{ path: string; visits: number }> | null;
  devices: Array<{ device: Device | 'unknown'; visits: number }> | null;
  /** С какого момента пишется класс устройства (ISO), null — ещё ни одной строки. */
  device_since: string | null;
  /**
   * Боты, свои и ИИ-краулеры за то же окно, в тех же суточных хэшах.
   * null — замер не удался, это не ноль.
   */
  aside: { bots: number; selfs: number; ai: number } | null;
  failed: Array<{ measure: string; error: string }>;
}

export async function buildVisitBreakdown(w: FunnelWindow, exec: FunnelExecutor = pool): Promise<VisitBreakdown> {
  const params = windowParams(w);
  const BASE = `${WINDOW_SQL} AND is_bot = FALSE AND is_self = FALSE AND visitor_hash IS NOT NULL`;
  const asideParams = [...params, AI_FAMILY_NAMES];

  const first = await measure('visits.first_hit', async () => (await exec.query<{ referrer: string | null; path: string }>(
    `SELECT DISTINCT ON (visitor_hash) referrer, path
       FROM page_views WHERE ${BASE}
      ORDER BY visitor_hash, created_at`,
    params,
  )).rows);

  // Отдельным замером: колонка device появилась миграцией 1304, и её отказ
  // не должен гасить источники.
  const aside = await measure('visits.aside', async () => (await exec.query<{
    bots: number; selfs: number; ai: number;
  }>(
    `SELECT COUNT(DISTINCT visitor_hash) FILTER (WHERE is_self)::int AS selfs,
            COUNT(DISTINCT visitor_hash) FILTER (
              WHERE is_bot AND NOT is_self AND ua_family = ANY ($3::text[])
            )::int AS ai,
            COUNT(DISTINCT visitor_hash) FILTER (
              WHERE is_bot AND NOT is_self
                AND (ua_family IS NULL OR NOT (ua_family = ANY ($3::text[])))
            )::int AS bots
       FROM page_views
      WHERE ${WINDOW_SQL} AND visitor_hash IS NOT NULL`,
    asideParams,
  )).rows[0] ?? { bots: 0, selfs: 0, ai: 0 });

  const dev = await measure('visits.device', async () => {
    const rows = (await exec.query<{ device: string | null; visits: number }>(
      `SELECT d.device, COUNT(*)::int AS visits FROM (
         SELECT DISTINCT ON (visitor_hash) device FROM page_views WHERE ${BASE}
          ORDER BY visitor_hash, created_at) d
        GROUP BY 1 ORDER BY 2 DESC`,
      params,
    )).rows;
    const since = (await exec.query<{ since: string | null }>(
      `SELECT MIN(created_at)::text AS since FROM page_views WHERE device IS NOT NULL`,
    )).rows[0]?.since ?? null;
    return { rows, since };
  });

  let sources: VisitBreakdown['sources'] = null;
  let landing: VisitBreakdown['landing'] = null;
  if (first.value) {
    const groups = new Map<SourceGroup, Map<string, number>>();
    const land = new Map<string, number>();
    for (const r of first.value) {
      const host = referrerHost(r.referrer);
      const g = sourceGroup(host);
      const hosts = groups.get(g) ?? new Map<string, number>();
      if (host && g !== 'internal') hosts.set(host, (hosts.get(host) ?? 0) + 1);
      else hosts.set('', (hosts.get('') ?? 0) + 1);
      groups.set(g, hosts);
      const p = (r.path || '/').split('?')[0];
      land.set(p, (land.get(p) ?? 0) + 1);
    }
    sources = [...groups.entries()].map(([group, hosts]) => {
      let total = 0;
      for (const n of hosts.values()) total += n;
      return {
        group, label: SOURCE_GROUP_LABEL[group], visits: total,
        hosts: [...hosts.entries()].filter(([h]) => h).map(([host, visits]) => ({ host, visits }))
          .sort((a, b) => b.visits - a.visits).slice(0, 6),
      };
    }).sort((a, b) => b.visits - a.visits);
    landing = [...land.entries()].map(([path, visits]) => ({ path, visits }))
      .sort((a, b) => b.visits - a.visits).slice(0, 10);
  }

  const failed: VisitBreakdown['failed'] = [];
  if (first.failed) failed.push({ measure: 'источники и страницы входа', error: first.failed });
  if (dev.failed) failed.push({ measure: 'устройства', error: dev.failed });
  if (aside.failed) failed.push({ measure: 'боты и свои', error: aside.failed });

  return {
    visits: first.value ? first.value.length : null,
    sources,
    landing,
    devices: dev.value ? dev.value.rows.map((r) => ({
      device: (r.device === 'mobile' || r.device === 'tablet' || r.device === 'desktop') ? r.device : 'unknown' as const,
      visits: r.visits,
    })) : null,
    device_since: dev.value?.since ?? null,
    aside: aside.failed || !aside.value ? null : aside.value,
    failed,
  };
}
