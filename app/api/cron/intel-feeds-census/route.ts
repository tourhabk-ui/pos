/**
 * GET /api/cron/intel-feeds-census — живы ли ленты разведки. Bearer CRON_SECRET.
 *
 * Только чтение: опрашивает настроенные источники и говорит по каждому, что
 * он отдал. Ни строки в базу.
 *
 * ── Зачем перепись, если есть проба с раннера ──────────────────────────────
 *
 * Замер 06.09 показал, что ответы РАЗНЫЕ у одного адреса. С прода
 * `www.kamgov.ru/news/rss` отдавал HTTP 404, с раннера GitHub — 403; у
 * `visitkamchatka.ru` наоборот: с прода 200 и HTML, с раннера 404. Российские
 * сайты закрываются от зарубежных адресов, зарубежные — от российских, и
 * судить о ленте с чужой машины значит чинить не то.
 *
 * Ленты читает ПРОД, значит и спрашивать их надо с прода. Проба с раннера
 * (feeds-probe.yml) остаётся — она отвечает на другой вопрос: «а не в нашей ли
 * стране дело».
 *
 * ── Что перепись НЕ решает ────────────────────────────────────────────────
 *
 * Она не судит, нужна ли лента: мёртвый адрес может иметь живой аналог, а
 * пустая лента — просто молчать неделю. Перепись даёт факты по каждой строке,
 * решение о списке источников принимает человек (§4.0: приговор не выводится
 * из пустоты).
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { fetchFeed } from '@/lib/services/intelligence-monitor.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface FeedRow { url: string; domain: string; label: string; active: boolean }

interface FeedVerdict {
  url: string;
  domain: string;
  label: string;
  /** 'feed' — настоящая лента с записями; 'empty' — лента без записей;
   *  'not_a_feed' — ответ есть, но это не лента; 'failed' — отказ. */
  verdict: 'feed' | 'empty' | 'not_a_feed' | 'failed';
  items: number | null;
  bytes: number | null;
  kind: string | null;
  error: string | null;
}

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rows: FeedRow[];
  try {
    const res = await pool.query<FeedRow>(
      `SELECT url, domain, label, active
         FROM intelligence_sources
        WHERE source_type = 'rss'
        ORDER BY domain, url`,
    );
    rows = res.rows;
  } catch (err) {
    // Не смогли прочитать список — так и говорим. Пустой список выглядел бы
    // как «лент нет вовсе», а это другая беда и чинится в другом месте.
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[intel-feeds-census] список источников не прочитан:', msg);
    return NextResponse.json(
      { probe: 'intel_feeds_census_v1', ok: null, error: `список источников не прочитан: ${msg}` },
      { status: 200 },
    );
  }

  const feeds: FeedVerdict[] = [];
  for (const row of rows) {
    if (!row.active) {
      feeds.push({ ...row, verdict: 'failed', items: null, bytes: null, kind: null, error: 'отключена в реестре' });
      continue;
    }
    try {
      const res = await fetchFeed(row.url);
      feeds.push({
        url: row.url, domain: row.domain, label: row.label,
        verdict: res.items.length > 0 ? 'feed' : (res.kind === 'rss' || res.kind === 'atom' ? 'empty' : 'not_a_feed'),
        items: res.items.length, bytes: res.bytes, kind: res.kind, error: null,
      });
    } catch (err) {
      feeds.push({
        url: row.url, domain: row.domain, label: row.label,
        verdict: 'failed', items: null, bytes: null, kind: null,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }

  const byVerdict = feeds.reduce<Record<string, number>>((acc, f) => {
    acc[f.verdict] = (acc[f.verdict] ?? 0) + 1;
    return acc;
  }, {});

  // Домены без единой живой ленты: у них разведка молчит по построению, и
  // это ровно та беда, которую тревога Watchdog называла «no_signals».
  const domains = [...new Set(feeds.map((f) => f.domain))].map((domain) => {
    const own = feeds.filter((f) => f.domain === domain);
    return {
      domain,
      total: own.length,
      alive: own.filter((f) => f.verdict === 'feed').length,
      silent: own.filter((f) => f.verdict !== 'feed').map((f) => `${f.url} — ${f.error ?? f.verdict}`),
    };
  });

  return NextResponse.json({
    probe: 'intel_feeds_census_v1',
    checked_at: new Date().toISOString(),
    checked_from: 'prod',
    total: feeds.length,
    by_verdict: byVerdict,
    domains,
    feeds,
  });
}
