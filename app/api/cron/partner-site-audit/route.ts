/**
 * GET /api/cron/partner-site-audit — SEO-перепись сайта будущего партнёра С ПРОДА.
 * Authorization: Bearer <CRON_SECRET>. ТОЛЬКО ЧТЕНИЕ, ничего не пишет.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * 30.09 владелец попросил аудит сайта «Края вулканов» (volcanoesland.ru,
 * Эдуард Фролов) к разговору о сотрудничестве. Из песочницы агента сайт не
 * открывается: сервер сбрасывает соединение, хотя сертификат Let's Encrypt
 * действует до 12.10 (crt.sh), а iamkam.ru и vedarai.ru с той же точки
 * открываются. Похоже на фильтр по стране — и если так, сайта не видят ни
 * иностранцы, ни роботы AI-поиска. Проверить это и снять сами страницы может
 * только точка в РФ, то есть прод.
 *
 * ── Почему адреса зашиты в код ─────────────────────────────────────────────
 *
 * Роут, который ходит по адресу из параметра, — это SSRF (тот же довод, что в
 * `source-probe`). Параметров нет: хост один и назван здесь; карточки туров
 * берутся из листинга того же хоста, по шаблону пути и не больше TOUR_LIMIT.
 * Перенаправления на чужой хост не проходятся — записываются и всё.
 *
 * ── Вежливость ─────────────────────────────────────────────────────────────
 *
 * Представляемся своим именем (`USER_AGENT` проверки сайтов операторов):
 * владелец сайта должен узнать нас в логах. Запросов за прогон — около
 * двадцати, по одному за раз.
 *
 * ── Своя сторона ───────────────────────────────────────────────────────────
 *
 * Отдельным блоком `used_by_vedar` — сколько наших мест, маршрутов и снимков
 * записаны с этого сайта (`source_url`). Это к тому же разговору: прежде чем
 * предлагать сотрудничество, надо знать, что мы уже взяли.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { USER_AGENT } from '@/lib/security/site-audit';
import { snapshotPage, tourLinks, type PageSnapshot } from '@/lib/seo/page-snapshot';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const HOST = 'volcanoesland.ru';
const ALLOWED_HOSTS = new Set([HOST, `www.${HOST}`]);
const BASE = `https://${HOST}`;

/** Страницы, названные поимённо: главная, разделы и три вулкана из выдачи. */
const PAGES: ReadonlyArray<string> = [
  '/',
  '/tours/',
  '/company/',
  '/residence/',
  '/attractions/avachinskiy/',
  '/attractions/gorelyy/',
  '/attractions/kurilskoe-ozero/',
  '/tours/?filter=Y&types=48',
];

/** Служебные файлы: читаются как текст, не как страница. */
const FILES: ReadonlyArray<string> = ['/robots.txt', '/sitemap.xml'];

/** Как выглядит адрес для поисковика: схема и www. Проверяется цепочка редиректов. */
const VARIANTS: ReadonlyArray<string> = [
  `http://${HOST}/`,
  `http://www.${HOST}/`,
  `https://www.${HOST}/`,
  `${BASE}/tours`,
  `${BASE}/net-takoy-stranicy-vedar-check/`,
];

const TOUR_LIMIT = 4;
const TOUR_PATH = /^\/tours\/[a-z0-9-]+\/$/i;
const TIMEOUT_MS = 8_000;
const MAX_HOPS = 5;
/**
 * Общий срок прогона. prod-check ждёт ответа 60 секунд; если сайт отвечает
 * медленно, лучше вернуть снятое и назвать пропущенное, чем не вернуть ничего.
 */
const DEADLINE_MS = 45_000;

interface Hop { url: string; status: number | null; location: string | null }

interface Fetched {
  url: string;
  hops: Hop[];
  final_url: string | null;
  status: number | null;
  content_type: string | null;
  bytes: number | null;
  ms: number | null;
  headers: Record<string, string>;
  body: string | null;
  error: string | null;
}

const KEPT_HEADERS = ['server', 'x-powered-by', 'x-robots-tag', 'cache-control', 'strict-transport-security', 'content-encoding', 'last-modified'];

async function get(url: string, deadlineAt: number): Promise<Fetched> {
  if (Date.now() > deadlineAt) {
    // Не спросили — не «страницы нет»: пропуск называется своим словом.
    return { url, hops: [], final_url: null, status: null, content_type: null, bytes: null, ms: null, headers: {}, body: null, error: 'skipped_deadline' };
  }
  const hops: Hop[] = [];
  let current = url;
  const started = Date.now();
  try {
    for (let i = 0; i <= MAX_HOPS; i += 1) {
      const res = await fetch(current, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = res.headers.get('location');
      hops.push({ url: current, status: res.status, location });
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current);
        // Чужой хост не проходим: записали, куда звал, и стоп.
        if (!ALLOWED_HOSTS.has(next.hostname)) {
          return { url, hops, final_url: next.toString(), status: res.status, content_type: null, bytes: null, ms: Date.now() - started, headers: {}, body: null, error: 'redirect_to_foreign_host' };
        }
        current = next.toString();
        continue;
      }
      const body = await res.text();
      const headers: Record<string, string> = {};
      for (const h of KEPT_HEADERS) {
        const v = res.headers.get(h);
        if (v) headers[h] = v.slice(0, 200);
      }
      return {
        url, hops, final_url: current, status: res.status,
        content_type: res.headers.get('content-type'),
        bytes: body.length, ms: Date.now() - started, headers, body, error: null,
      };
    }
    return { url, hops, final_url: current, status: null, content_type: null, bytes: null, ms: Date.now() - started, headers: {}, body: null, error: 'too_many_redirects' };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // Причина сетевого отказа у undici лежит в `cause`: без неё «fetch failed» ничего не говорит.
    const rawCause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
    const cause = rawCause instanceof Error ? ` (${rawCause.message})` : '';
    console.error(`[partner-site-audit] ${current}: ${message}${cause}`);
    return { url, hops, final_url: null, status: null, content_type: null, bytes: null, ms: Date.now() - started, headers: {}, body: null, error: `${message}${cause}`.slice(0, 200) };
  }
}

interface PageReport extends Omit<Fetched, 'body'> {
  snapshot: PageSnapshot | null;
}

function report(f: Fetched): PageReport {
  const { body, ...rest } = f;
  const isHtml = (f.content_type ?? '').includes('html');
  return { ...rest, snapshot: body && isHtml && f.final_url ? snapshotPage(body, f.final_url) : null };
}

interface UsageRow { what: string; total: number; visible: number }

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeCompare(getCronSecret(request) ?? '', secret)) {
    if (!secret) console.error('[partner-site-audit] CRON_SECRET не настроен: перепись не выполнится');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const deadlineAt = Date.now() + DEADLINE_MS;

  // Страницы по одной: сайт чужой, нагружать его параллельными запросами незачем.
  const pages: PageReport[] = [];
  let listingHtml: string | null = null;
  for (const path of PAGES) {
    const f = await get(`${BASE}${path}`, deadlineAt);
    if (path === '/tours/' && f.body) listingHtml = f.body;
    pages.push(report(f));
  }

  const tours = listingHtml ? tourLinks(listingHtml, `${BASE}/tours/`, TOUR_PATH, TOUR_LIMIT) : [];
  for (const url of tours) pages.push(report(await get(url, deadlineAt)));

  const files: Array<{ url: string; status: number | null; bytes: number | null; head: string | null; sitemap_urls: number | null; error: string | null }> = [];
  for (const path of FILES) {
    const f = await get(`${BASE}${path}`, deadlineAt);
    files.push({
      url: f.url,
      status: f.status,
      bytes: f.bytes,
      head: f.body ? f.body.slice(0, path === '/robots.txt' ? 2000 : 600) : null,
      sitemap_urls: f.body && path === '/sitemap.xml' ? (f.body.match(/<loc>/g) ?? []).length : null,
      error: f.error,
    });
  }

  const variants: Array<{ url: string; hops: Hop[]; final_status: number | null; error: string | null }> = [];
  for (const url of VARIANTS) {
    const f = await get(url, deadlineAt);
    variants.push({ url, hops: f.hops, final_status: f.status, error: f.error });
  }

  // Своя сторона. Отказ базы не роняет перепись сайта: она уже снята, а
  // «не смогли посчитать» называется вслух, а не нулём (§4.0).
  let usedByVedar: UsageRow[] | null = null;
  let usedError: string | null = null;
  try {
    const pattern = `%${HOST}%`;
    const { rows } = await pool.query<UsageRow>(
      `SELECT 'places' AS what, count(*)::int AS total,
              count(*) FILTER (WHERE is_visible AND merged_into_id IS NULL)::int AS visible
         FROM places WHERE source_url ILIKE $1
       UNION ALL
       SELECT 'kamchatka_routes', count(*)::int,
              count(*) FILTER (WHERE is_visible AND merged_into_id IS NULL)::int
         FROM kamchatka_routes WHERE source_url ILIKE $1
       UNION ALL
       SELECT 'ai_route_images', count(*)::int, count(*)::int
         FROM ai_route_images WHERE source_url ILIKE $1
       UNION ALL
       SELECT 'place_gallery_photos', count(*)::int, count(*)::int
         FROM place_gallery_photos WHERE source_url ILIKE $1`,
      [pattern],
    );
    usedByVedar = rows;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[partner-site-audit] своя сторона не посчитана:', { sqlstate: e?.code, message: e?.message });
    usedError = e?.message ?? 'база не ответила';
  }

  const reached = pages.filter((p) => p.status !== null).length;
  const skipped = [...pages, ...files, ...variants].filter((x) => x.error === 'skipped_deadline').length;
  return NextResponse.json({
    ok: reached > 0,
    probe: 'partner_site_audit_v1',
    measured_at: new Date().toISOString(),
    vantage: 'prod',
    host: HOST,
    // Ноль страниц при непустом списке — отказ, а не «сайт пустой» (§4.0).
    reached_pages: reached,
    asked_pages: pages.length,
    skipped_by_deadline: skipped,
    pages,
    files,
    variants,
    used_by_vedar: usedByVedar,
    used_by_vedar_error: usedError,
  }, { status: reached > 0 ? 200 : 502 });
}
