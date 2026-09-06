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
import { fetchFeed, fetchPage } from '@/lib/services/intelligence-monitor.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface FeedRow { url: string; domain: string; label: string; active: boolean; source_type: string; page_prefix: string | null }

interface FeedVerdict {
  url: string;
  domain: string;
  label: string;
  /** 'feed' — настоящая лента с записями; 'page' — страница, разбор дал записи;
   *  'empty' — ответ есть, записей нет; 'not_a_feed' — ответ есть, но это не лента;
   *  'failed' — отказ. */
  verdict: 'feed' | 'page' | 'empty' | 'not_a_feed' | 'failed';
  items: number | null;
  bytes: number | null;
  kind: string | null;
  error: string | null;
  /** Что вытащил разбор страницы — только для HTML. Пусто при живых якорях = смена вёрстки. */
  page?: { anchors: number; prefix: string; titles: string[] };
}

/**
 * Разбор страницы как второй вопрос к тому же адресу.
 *
 * Ответ «это не лента» сам по себе приговора не выносит: у Anthropic лент нет
 * вовсе, и страница — единственный путь к главному источнику. Поэтому HTML
 * спрашивается ещё раз разбором, и в ответе видно, сколько записей он нашёл и
 * сколько якорей было всего.
 */
async function probePage(url: string, prefix?: string): Promise<{ found: number; page: NonNullable<FeedVerdict['page']> } | null> {
  try {
    const page = await fetchPage(url, prefix);
    return {
      found: page.items.length,
      page: { anchors: page.anchors, prefix: page.prefix, titles: page.items.slice(0, 3).map((i) => i.title) },
    };
  } catch {
    return null;
  }
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

/**
 * Кандидат записывается как `адрес` или `адрес|префикс`: у страницы-ленты
 * записи не всегда лежат под путём самой страницы (у Anthropic лежат, у taaft
 * нет), и проверить это надо ДО того, как строка попадёт в реестр.
 */
function acceptCandidate(raw: string): { url: string; prefix?: string } | { error: string } {
  const [rawUrl, rawPrefix] = raw.trim().split('|');
  let u: URL;
  try { u = new URL(rawUrl.trim()); } catch { return { error: 'не разбирается как URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `протокол ${u.protocol} не разрешён` };
  if (u.username || u.password) return { error: 'учётные данные в адресе не разрешены' };
  if (PRIVATE_HOST.test(u.hostname)) return { error: 'частный адрес не разрешён' };
  const prefix = (rawPrefix ?? '').trim();
  if (prefix && !prefix.startsWith('/')) return { error: 'префикс должен начинаться со слеша' };
  return prefix ? { url: u.toString(), prefix } : { url: u.toString() };
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
        const isFeedBody = res.kind === 'rss' || res.kind === 'atom';
        const probed = isFeedBody ? null : await probePage(accepted.url, accepted.prefix);
        const asPage = Boolean(probed && probed.found > 0);
        checked.push({
          url: accepted.url + (accepted.prefix ? `|${accepted.prefix}` : ''),
          domain: 'candidate', label: '',
          verdict: res.items.length > 0 ? 'feed' : (isFeedBody ? 'empty' : (asPage ? 'page' : 'not_a_feed')),
          // Записей столько, сколько нашёл тот разбор, которым источник и будет
          // читаться: у страницы это разбор ссылок, а не разбор ленты (у него
          // всегда ноль — и цифра «0» рядом с приговором `page` врала бы).
          items: asPage ? probed!.found : res.items.length,
          bytes: res.bytes, kind: res.kind, error: null,
          ...(probed ? { page: probed.page } : {}),
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
      alive: checked
        .filter((c) => c.verdict === 'feed' || c.verdict === 'page')
        .map((c) => c.verdict === 'page'
          ? `${c.url} (страница, записей: ${c.page?.titles.length ?? 0}, якорей: ${c.page?.anchors ?? 0})`
          : `${c.url} (записей: ${c.items})`),
      feeds: checked,
    });
  }

  let rows: FeedRow[];
  try {
    const res = await pool.query<FeedRow>(
      `SELECT url, domain, label, active, source_type, page_prefix
         FROM intelligence_sources
        WHERE source_type IN ('rss', 'page')
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
    if (row.source_type === 'page') {
      // Страницу судит разбор, а не форма тела: ленты у такого источника нет
      // по построению, и мерить его меркой ленты значит всегда получать «нет».
      try {
        const page = await fetchPage(row.url, row.page_prefix ?? undefined);
        feeds.push({
          url: row.url, domain: row.domain, label: row.label,
          verdict: page.items.length > 0 ? 'page' : 'empty',
          items: page.items.length, bytes: page.bytes, kind: 'html', error: null,
          page: { anchors: page.anchors, prefix: page.prefix, titles: page.items.slice(0, 3).map((i) => i.title) },
        });
      } catch (err) {
        feeds.push({
          url: row.url, domain: row.domain, label: row.label,
          verdict: 'failed', items: null, bytes: null, kind: 'html',
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
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
      alive: own.filter((f) => f.verdict === 'feed' || f.verdict === 'page').length,
      silent: own
        .filter((f) => f.verdict !== 'feed' && f.verdict !== 'page')
        .map((f) => `${f.url} — ${f.error ?? f.verdict}`),
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
