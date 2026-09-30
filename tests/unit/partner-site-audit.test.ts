/**
 * SEO-перепись сайта партнёра: разбор страницы честный, роут не превращается в
 * открытый прокси и ничего не пишет. Шапка — app/api/cron/partner-site-audit/route.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotPage, tourLinks } from '@/lib/seo/page-snapshot';
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
  it('без параметров: адрес из запроса не читается (иначе SSRF)', () => {
    expect(SRC).not.toMatch(/searchParams|nextUrl|request\.url/);
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
