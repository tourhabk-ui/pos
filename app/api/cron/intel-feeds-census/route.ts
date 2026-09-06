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

/**
 * Кандидаты на замену — тем же путём и с той же машины.
 *
 * Замена мёртвой ленты выбирается замером, а не памятью: адрес, живой у
 * поисковика, может отдавать проду 404 или HTML. Проверка кандидатов ничего
 * не записывает — решение о списке принимает человек.
 *
 * Ограничения не для красоты: роут ходит по адресу из параметра, и без них
 * он стал бы дверью во внутреннюю сеть (SSRF). Поэтому только http(s), не
 * больше пятнадцати за раз, без учётных данных в URL и без частных адресов.
 */
const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|metadata\.)/i;

function acceptCandidate(raw: string): { url: string } | { error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { error: 'не разбирается как URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `протокол ${u.protocol} не разрешён` };
  if (u.username || u.password) return { error: 'учётные данные в адресе не разрешены' };
  if (PRIVATE_HOST.test(u.hostname)) return { error: 'частный адрес не разрешён' };
  return { url: u.toString() };
}

const MAX_CANDIDATES = 15;

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ?urls=… — проверить кандидатов, ничего не записывая.
  const candidatesParam = (req.nextUrl.searchParams.get('urls') ?? '').trim();
  if (candidatesParam) {
    const raw = candidatesParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_CANDIDATES);
    const checked: FeedVerdict[] = [];
    for (const item of raw) {
      const accepted = acceptCandidate(item);
      if ('error' in accepted) {
        checked.push({ url: item, domain: 'candidate', label: '', verdict: 'failed', items: null, bytes: null, kind: null, error: accepted.error });
        continue;
      }
      try {
        const res = await fetchFeed(accepted.url);
        checked.push({
          url: accepted.url, domain: 'candidate', label: '',
          verdict: res.items.length > 0 ? 'feed' : (res.kind === 'rss' || res.kind === 'atom' ? 'empty' : 'not_a_feed'),
          items: res.items.length, bytes: res.bytes, kind: res.kind, error: null,
        });
      } catch (err) {
        checked.push({
          url: accepted.url, domain: 'candidate', label: '', verdict: 'failed',
          items: null, bytes: null, kind: null,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
    }
    return NextResponse.json({
      probe: 'intel_feeds_census_v1',
      mode: 'candidates',
      checked_at: new Date().toISOString(),
      checked_from: 'prod',
      requested: raw.length,
      alive: checked.filter((c) => c.verdict === 'feed').map((c) => `${c.url} (записей: ${c.items})`),
      feeds: checked,
    });
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

  // Чем прод вообще может читать НЕ-ленты. Anthropic новостей лентой не
  // публикует (замер 06.09: /news отдаёт страницу, три RSS-адреса — 404), и
  // единственный путь к ним — разбор страницы. Настроен ли инструмент, по
  // молчанию разведки не видно: без ключа Firecrawl просто ничего не вернёт.
  // Имена переменных без значений — так же, как в payment-config.
  const tools = {
    firecrawl: Boolean((process.env.FIRECRAWL_API_KEY ?? '').trim()),
    tavily: Boolean((process.env.TAVILY_API_KEY ?? '').trim()),
    brave: Boolean((process.env.BRAVE_SEARCH_API_KEY ?? '').trim()),
  };

  return NextResponse.json({
    probe: 'intel_feeds_census_v1',
    checked_at: new Date().toISOString(),
    checked_from: 'prod',
    tools,
    total: feeds.length,
    by_verdict: byVerdict,
    domains,
    feeds,
  });
}
