/**
 * SEO-перепись сайта партнёра: разбор страницы честный, роут не превращается в
 * открытый прокси и ничего не пишет. Шапка — app/api/cron/partner-site-audit/route.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { snapshotPage, tourLinks, mediaRefs } from '@/lib/seo/page-snapshot';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/partner-site-audit/route.ts'), 'utf-8');

const PAGE = `<!doctype html><html lang="ru"><head>
<title>Горелый</title>
<meta name="description" content="Восхождение на вулкан Горелый &laquo;за день&raquo;">
<meta name="viewport" content="width=device-width">
<meta property="og:title" content="Горелый">
<link rel="canonical" href="https://volcanoesland.ru/attractions/gorelyy/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"TouristTrip","name":"Горелый"}</script>
<script type="application/ld+json">{broken</script>
<script>ym(123, "init")</script>
</head><body>
<h1>Главная / Достопримечательности / Горелый</h1>
<h2>Описание</h2><h3>Как добраться</h3>
<img src="/a.jpg" alt="Кратер"><img src="/b.jpg"><img src="/c.jpg" alt="  ">
<a href="/tours/gorelyy-1/">Тур</a><a href="https://vk.com/x">VK</a>
<a href="tel:+7 (914) 029-11-12">звоните</a><a href="mailto:mail@volcanoesland.ru">почта</a>
<p>Или 8 961 960-00-09</p>
</body></html>`;

describe('snapshotPage', () => {
  const s = snapshotPage(PAGE, 'https://volcanoesland.ru/attractions/gorelyy/');

  it('снимает заголовок, описание с сущностями, canonical и язык', () => {
    expect(s.title).toBe('Горелый');
    expect(s.description).toBe('Восхождение на вулкан Горелый «за день»');
    expect(s.canonical).toBe('https://volcanoesland.ru/attractions/gorelyy/');
    expect(s.lang).toBe('ru');
    expect(s.viewport).toBe(true);
  });

  it('заголовки по уровням, включая крошки в H1 — как есть, без правки', () => {
    expect(s.h1).toEqual(['Главная / Достопримечательности / Горелый']);
    expect(s.h2).toEqual(['Описание']);
    expect(s.h3).toEqual(['Как добраться']);
  });

  it('битая микроразметка считается отдельно, а не глотается', () => {
    expect(s.jsonld_types).toEqual(['TouristTrip']);
    expect(s.jsonld_invalid).toBe(1);
  });

  it('картинка с пустым alt — без alt', () => {
    expect(s.images_total).toBe(3);
    expect(s.images_without_alt).toBe(2);
  });

  it('телефоны из ссылки и из текста приводятся к +7, почта собирается', () => {
    expect(s.phones).toEqual(['+79140291112', '+79619600009']);
    expect(s.emails).toEqual(['mail@volcanoesland.ru']);
  });

  it('ОГРН и маска поля формы — не телефоны (замер 30.09, tourkamchatka.ru)', () => {
    const p = snapshotPage(
      '<html><body><p>ОГРН 1184101002227, ИНН 4101184305</p><p>Телефон: +7 (999) 999-99-99</p><p>+7 914 027-89-66</p></body></html>',
      'https://tourkamchatka.ru/about',
    );
    expect(p.phones).toEqual(['+79140278966']);
  });

  it('свои ссылки отдельно от чужих хостов, счётчики опознаются', () => {
    expect(s.internal_links).toBe(1);
    expect(s.external_hosts).toEqual(['vk.com']);
    expect(s.counters).toEqual(['yandex_metrika']);
  });

  it('пустая страница — пустые поля, а не выдумка', () => {
    const e = snapshotPage('<html><body></body></html>', 'https://volcanoesland.ru/');
    expect(e.title).toBeNull();
    expect(e.description).toBeNull();
    expect(e.h1).toEqual([]);
    expect(e.words).toBe(0);
  });
});

describe('tourLinks', () => {
  it('только свой хост и шаблон карточки, с потолком', () => {
    const html = `<a href="/tours/a/">1</a><a href="/tours/?filter=Y">f</a>
      <a href="https://evil.example/tours/b/">x</a><a href="https://www.volcanoesland.ru/tours/c/">2</a>
      <a href="/tours/d/">3</a>`;
    expect(tourLinks(html, 'https://volcanoesland.ru/tours/', /^\/tours\/[a-z0-9-]+\/$/i, 2))
      .toEqual(['https://volcanoesland.ru/tours/a/', 'https://volcanoesland.ru/tours/c/']);
  });
});

describe('роут partner-site-audit', () => {
  it('из запроса читается только режим part, адреса — никогда (иначе SSRF)', () => {
    expect(SRC).not.toMatch(/request\.url/);
    const reads = [...SRC.matchAll(/searchParams\.get\(([^)]*)\)/g)].map((m) => m[1]);
    expect(reads).toEqual(["'part'"]);
  });

  it('чужой хост в редиректе не проходится', () => {
    expect(SRC).toContain("redirect: 'manual'");
    expect(SRC).toContain('redirect_to_foreign_host');
  });

  it('только чтение базы', () => {
    expect(SRC).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/);
  });

  it('закрыт секретом крона и представляется своим именем', () => {
    expect(SRC).toContain('timingSafeCompare(getCronSecret(request)');
    expect(SRC).toContain("'User-Agent': USER_AGENT");
  });

  it('ноль снятых страниц — отказ, а не пустой успех', () => {
    expect(SRC).toMatch(/ok: reached > 0/);
    expect(SRC).toMatch(/status: reached > 0 \? 200 : 502/);
  });

  it('объявлен ручным и ничего не пишущим', () => {
    expect(MANUAL_ENDPOINTS['partner-site-audit']).toMatchObject({ kind: 'manual', writes: false });
  });
});

describe('mediaRefs — ролики на странице (08.11, клипы «Края Вулканов»)', () => {
  const URL0 = 'https://volcanoesland.ru/tours/gorelyy/';

  it('файлы из <video>/<source> и ссылок, плееры из <iframe>, площадки и Telegram — по отдельности', () => {
    const m = mediaRefs(`
      <video src="/upload/v/gorelyy.mp4" poster="/p.jpg"></video>
      <video><source src="https://cdn.volcanoesland.ru/v/a.webm?x=1" type="video/webm"></video>
      <a href="/files/tour.mov">ролик</a>
      <iframe src="https://rutube.ru/play/embed/abc123"></iframe>
      <a href="https://www.youtube.com/watch?v=xyz">YouTube</a>
      <a href="https://t.me/volcanoesland_chan/15">пост</a>
      <img src="/a.jpg"><a href="/tours/b/">тур</a>
      <script>var g={"src":"https:\\/\\/volcanoesland.ru\\/upload\\/clip.mp4"};</script>`, URL0);
    expect(m.files).toEqual([
      'https://volcanoesland.ru/upload/v/gorelyy.mp4',
      'https://cdn.volcanoesland.ru/v/a.webm?x=1',
      'https://volcanoesland.ru/files/tour.mov',
      // Ролик из JSON галереи в скрипте (экранированные слэши) — тоже найден.
      'https://volcanoesland.ru/upload/clip.mp4',
    ]);
    expect(m.iframes).toEqual(['https://rutube.ru/play/embed/abc123']);
    expect(m.platforms).toEqual(expect.arrayContaining(['https://rutube.ru/play/embed/abc123', 'https://www.youtube.com/watch?v=xyz', 'https://t.me/volcanoesland_chan/15']));
    expect([...m.files, ...m.platforms].some((u) => /\.jpg|\/tours\/b\//.test(u))).toBe(false);
  });

  it('страница без роликов — пустые списки, а не выдумка', () => {
    expect(mediaRefs('<html><body><img src="/a.jpg"><a href="/tours/b/">x</a></body></html>', URL0))
      .toEqual({ files: [], iframes: [], platforms: [] });
  });
});

describe('роут partner-site-audit, режим part=media — вызовом', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.CRON_SECRET; });

  it('главная, листинг и карточки туров того же хоста; чужой адрес из запроса не трогается', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-test-0001';
    const asked: string[] = [];
    const pagesByPath: Record<string, string> = {
      '/': '<html><title>Край Вулканов</title><video src="/upload/main.mp4"></video></html>',
      '/tours/': '<html><a href="/tours/gorelyy/">1</a><a href="/tours/tolbachik/">2</a><a href="https://evil.example/tours/x/">3</a></html>',
      '/tours/gorelyy/': '<html><title>Горелый</title><iframe src="https://rutube.ru/play/embed/g1"></iframe></html>',
      '/tours/tolbachik/': '<html><title>Толбачик</title><p>без роликов</p></html>',
    };
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const u = new URL(String(input));
      asked.push(u.toString());
      const body = pagesByPath[u.pathname];
      return new Response(body ?? 'нет', { status: body ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }) as unknown as typeof fetch;
    const { GET } = await import('@/app/api/cron/partner-site-audit/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/partner-site-audit?part=media&url=https://evil.example/', {
      headers: { authorization: 'Bearer cron-secret-for-test-0001' },
    }));
    expect(res.status).toBe(200);
    const j = await res.json() as { probe: string; tour_pages_found: number; pages_with_media: number; pages: Array<{ url: string; title: string | null; media: { files: string[]; iframes: string[] } | null }> };
    expect(j.probe).toBe('partner_site_media_v1');
    expect(j.tour_pages_found).toBe(2);
    expect(j.pages.map((p) => p.url)).toEqual([
      'https://volcanoesland.ru/', 'https://volcanoesland.ru/tours/',
      'https://volcanoesland.ru/tours/gorelyy/', 'https://volcanoesland.ru/tours/tolbachik/',
    ]);
    expect(j.pages[0]!.media?.files).toEqual(['https://volcanoesland.ru/upload/main.mp4']);
    expect(j.pages[2]!.media?.iframes).toEqual(['https://rutube.ru/play/embed/g1']);
    expect(j.pages_with_media).toBe(2);
    expect(asked.every((u) => new URL(u).hostname === 'volcanoesland.ru')).toBe(true);
  });

  it('сайт не ответил ни одной страницей — 502 и ok: false, а не «роликов нет»', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-test-0001';
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const { GET } = await import('@/app/api/cron/partner-site-audit/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/partner-site-audit?part=media', {
      headers: { authorization: 'Bearer cron-secret-for-test-0001' },
    }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, reached_pages: 0 });
  });
});
