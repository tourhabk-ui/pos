/**
 * Прогон наблюдения за сайтами партнёров: какие страницы, чтение, снимок,
 * сообщение владельцу. Правила сравнения — в `site-watch.ts`.
 *
 * Кого читаем (ответ владельца 22.10 «всех с сайтом, сами»): партнёра, у
 * которого записан сайт и чей хоть один тур стоит у нас на витрине (шлюз
 * `publicTourSql`: черновик туриста не обманывает) или который проверен
 * владельцем. Записан ли у тура адрес страницы-источника, для отбора не
 * важно: у «Камчатской рыбалки» его нет (1106 сверяла туры с одностраничным
 * сайтом), а сайт её — тот, с которого собраны карточки. Без условия витрины
 * в очередь попал бы весь справочник операторов, импортированный с
 * visitkamchatka, — чужие сайты, к нашим карточкам отношения не имеющие.
 * Страницы — главная сайта и страницы-источники его туров на витрине
 * (`operator_tours.source_url`) на его же домене.
 *
 * Как читаем: `safeFetchText` — каждый адрес и каждое перенаправление
 * судятся заново (SSRF: адрес сайта оператор вписывает в кабинете сам),
 * представляемся своим именем, robots.txt сайта соблюдаем, страницы одного
 * сайта читаем подряд с паузой. Не чаще раза в сутки на страницу.
 */
import { pool } from '@/lib/db-pool';
import { safeFetchText } from '@/lib/agents/scout-fetch';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { notifyOwnerPartnerSites } from '@/lib/telegram/admin-notify';
import type { TgSendOutcome } from '@/lib/notifications/tg-send';
import {
  WATCH_USER_AGENT, baselineMessage, diffLines, ownerMessage, pageText, robotsDisallows, textHash, watchEvent,
  type PageOutcome, type PageReport, type Snapshot, type TextDiff, type WatchedPage,
} from '@/lib/partners/site-watch';

/** Сколько страниц за прогон. Очередь идёт от дольше всех не читанных. */
export const PAGES_PER_RUN = 60;
/** Пауза между запросами к одному сайту, мс. */
const PAUSE_MS = 1_000;

export interface WatchedRow extends WatchedPage { partnerId: string }

/**
 * Страницы под наблюдением. Домен — без «www.»; источник тура на чужом
 * домене (visitkamchatka, Telegram) сайтом партнёра не считается.
 */
export async function watchedPages(limit = PAGES_PER_RUN): Promise<WatchedRow[]> {
  const { rows } = await pool.query<{ partner_id: string; partner_name: string; url: string; tours: string[] }>(
    `WITH site AS (
       SELECT p.id, p.name,
              NULLIF(btrim(COALESCE(NULLIF(btrim(p.website), ''),
                                    CASE WHEN jsonb_typeof(p.contacts) = 'object' THEN p.contacts->>'website' END,
                                    CASE WHEN jsonb_typeof(p.contact) = 'object' THEN p.contact->>'website' END)), '') AS website,
              COALESCE(p.is_verified, FALSE) AS verified
         FROM partners p
     ), live AS (
       SELECT t.operator_id, t.title::text AS title, btrim(t.source_url) AS url
         FROM operator_tours t
        WHERE ${publicTourSql('t')}
     ), watched AS (
       SELECT s.id, s.name,
              CASE WHEN s.website ~* '^https?://' THEN s.website ELSE 'https://' || s.website END AS home,
              lower(regexp_replace(substring(s.website from '^(?:[a-zA-Z]+://)?([^/:?#]+)'), '^www\\.', '')) AS host
         FROM site s
        WHERE s.website IS NOT NULL
          AND (s.verified OR EXISTS (SELECT 1 FROM live l WHERE l.operator_id = s.id))
     ), pages AS (
       SELECT w.id AS partner_id, w.name AS partner_name, l.url, array_agg(DISTINCT l.title) AS tours
         FROM watched w
         JOIN live l ON l.operator_id = w.id
        WHERE l.url ~* '^https?://'
          AND lower(regexp_replace(substring(l.url from '^[a-zA-Z]+://([^/:?#]+)'), '^www\\.', '')) = w.host
        GROUP BY w.id, w.name, l.url
       UNION ALL
       SELECT w.id, w.name, w.home, ARRAY[]::text[] FROM watched w
     )
     SELECT DISTINCT ON (pg.url) pg.partner_id::text AS partner_id, pg.partner_name, pg.url, pg.tours
       FROM pages pg
      ORDER BY pg.url, cardinality(pg.tours) DESC`,
  );
  const last = await pool.query<{ url: string; at: string }>(
    `SELECT url, MAX(checked_at)::text AS at FROM partner_page_snapshots GROUP BY url`,
  );
  const lastAt = new Map(last.rows.map((r) => [r.url, r.at]));
  // Ни разу не читанные — первыми, затем дольше всех не читанные.
  return rows
    .map((r) => ({ partnerId: r.partner_id, partnerName: r.partner_name, url: r.url, tours: r.tours ?? [] }))
    .sort((a, b) => (lastAt.get(a.url) ?? '').localeCompare(lastAt.get(b.url) ?? ''))
    .slice(0, limit);
}

interface History { prev: Snapshot | null; prev2: Snapshot | null; okHash: string | null; okText: string | null }

async function history(url: string): Promise<History> {
  const recent = await pool.query<{ outcome: PageOutcome; text_hash: string | null }>(
    `SELECT outcome, text_hash FROM partner_page_snapshots WHERE url = $1 ORDER BY checked_at DESC, id DESC LIMIT 2`,
    [url],
  );
  const ok = await pool.query<{ text_hash: string; text: string | null }>(
    `SELECT text_hash, text FROM partner_page_snapshots
      WHERE url = $1 AND outcome = 'ok' ORDER BY checked_at DESC, id DESC LIMIT 1`,
    [url],
  );
  // Текст хранится только при смене: ищется последний сохранённый — он же
  // равен последнему удачному, пока хэш не менялся.
  const okText = ok.rows[0]
    ? (ok.rows[0].text ?? (await pool.query<{ text: string }>(
      `SELECT text FROM partner_page_snapshots
        WHERE url = $1 AND outcome = 'ok' AND text IS NOT NULL AND text_hash = $2
        ORDER BY checked_at DESC, id DESC LIMIT 1`,
      [url, ok.rows[0].text_hash],
    )).rows[0]?.text ?? null)
    : null;
  const snap = (r?: { outcome: PageOutcome; text_hash: string | null }): Snapshot | null =>
    r ? { outcome: r.outcome, hash: r.text_hash } : null;
  return { prev: snap(recent.rows[0]), prev2: snap(recent.rows[1]), okHash: ok.rows[0]?.text_hash ?? null, okText };
}

/** Одно чтение: исход, код и текст. Robots — по своему ответу на сайт за прогон. */
async function readPage(url: string, robotsCache: Map<string, string | null>): Promise<{
  outcome: PageOutcome; status: number | null; text: string | null; failure: string | null;
}> {
  let origin: string;
  let path: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    path = `${u.pathname}${u.search}`;
  } catch {
    return { outcome: 'failed', status: null, text: null, failure: 'адрес не разбирается' };
  }
  if (!robotsCache.has(origin)) {
    const r = await safeFetchText(`${origin}/robots.txt`, { userAgent: WATCH_USER_AGENT });
    robotsCache.set(origin, r.ok ? r.body : null);
  }
  if (robotsDisallows(robotsCache.get(origin) ?? null, path)) {
    return { outcome: 'robots', status: null, text: null, failure: 'robots.txt сайта запрещает чтение' };
  }
  const res = await safeFetchText(url, { userAgent: WATCH_USER_AGENT });
  if (res.ok) return { outcome: 'ok', status: 200, text: pageText(res.body), failure: null };
  if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status, text: null, failure: res.reason };
  return { outcome: 'failed', status: res.status ?? null, text: null, failure: res.reason };
}

export interface WatchRunResult {
  pages: number;
  events: Record<string, number>;
  reports: Array<{ url: string; partner: string; outcome: PageOutcome; event: string; status: number | null }>;
  /** Исход сообщения владельцу; null — сообщать было нечего. */
  notified: TgSendOutcome | null;
}

/**
 * Прогон. `sleep` подменяется в сторожах, чтобы не ждать паузы между
 * запросами; сеть подменяется подменой fetch.
 */
export async function runSiteWatch(opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<WatchRunResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pages = await watchedPages();
  const firstEver = (await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM partner_page_snapshots`)).rows[0].n === '0';
  const robotsCache = new Map<string, string | null>();
  const reports: PageReport[] = [];
  const out: WatchRunResult['reports'] = [];
  let lastOrigin = '';

  for (const page of pages) {
    const origin = (() => { try { return new URL(page.url).origin; } catch { return ''; } })();
    if (origin && origin === lastOrigin) await sleep(PAUSE_MS);
    lastOrigin = origin;

    const h = await history(page.url);
    const read = await readPage(page.url, robotsCache);
    const hash = read.text !== null ? textHash(read.text) : null;
    const event = watchEvent({ outcome: read.outcome, hash }, h.prev, h.prev2, h.okHash);
    let diff: TextDiff | undefined;
    if (event.kind === 'changed' && read.text !== null) diff = diffLines(h.okText ?? '', read.text);
    // Текст — при первом чтении и при смене; одинаковый не копится.
    const keepText = read.outcome === 'ok' && (h.okHash === null || hash !== h.okHash);
    await pool.query(
      `INSERT INTO partner_page_snapshots
         (partner_id, url, outcome, http_status, text_hash, text, diff, event, failure)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [page.partnerId, page.url, read.outcome, read.status, hash, keepText ? read.text : null,
        diff ? JSON.stringify({ removed: diff.removed.slice(0, 200), added: diff.added.slice(0, 200) }) : null,
        event.kind, read.failure],
    );
    reports.push({ page, event: event.kind, diff, httpStatus: read.status });
    out.push({ url: page.url, partner: page.partnerName, outcome: read.outcome, event: event.kind, status: read.status });
  }

  const events: Record<string, number> = {};
  for (const r of out) events[r.event] = (events[r.event] ?? 0) + 1;

  // Первый прогон — список, кого взяли под наблюдение: владелец сверяет его
  // со своими партнёрами. Дальше — только изменения (и в первом прогоне
  // тоже: страница тура, которой уже нет, ждать второго дня не должна).
  const text = [firstEver ? baselineMessage(pages) : null, ownerMessage(reports)].filter(Boolean).join('\n\n') || null;
  const notified = text ? await notifyOwnerPartnerSites(text) : null;
  return { pages: pages.length, events, reports: out, notified };
}
