// @vitest-environment node
/**
 * Перепись sitemap в scripts/site-audit.py (13.10) — проверка ПОВЕДЕНИЕМ:
 * скрипт идёт на поддельный сайт на локальном сервере, где каждая страница
 * несёт ровно один известный дефект, и обязан назвать каждый — тем числом и
 * в том разделе, где он есть. Текст скрипта здесь не судится (правило 13.10).
 *
 * Дефекты выбраны по аудиту 29.09 (docs/seo/audit-2026-09-29.md): canonical
 * вне <head> (Н4), два meta robots с разным смыслом (Н2), soft-404 (Н2),
 * редирект и 404 в sitemap (Н9), описание, оборванное посреди слова (Н11),
 * og:image, который не открывается (Н6). Чистая страница не должна попасть
 * ни в одну находку — иначе сторож кричит на здоровое.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const SCRIPT = join(process.cwd(), 'scripts/site-audit.py');

let server: Server;
let port = 0;
let dir = '';
const seenUA: string[] = [];
let limitedOnce = false;

const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(' ');
const DESC_OK = 'Вулкан Горелый: маршрут к кратеру, сезон, опасности и что взять с собой — по данным платформы.';
const DESC_CUT = 'Озеро Курильское: медведи, нерка, вертолётные экскурсии из Петропавловска, сезон с июля по сентябрь и всё что нужно знать до поездки на юг Камчатки, включая погоду и обстан';

// Навигация как на сайте: каждая страница ссылается на все прочие, кроме сироты.
const NAV = ['/places/good', '/places/body-canonical', '/routes/double-robots', '/routes/soft', '/routes/moved', '/operators/gone',
  '/places/cut', '/places/bad-og', '/places/streamed', '/places/limited', '/places/no-alt', '/places/og-head', '/places/bad-ld', '/places/long-title', '/list',
  // Как таб-бар Ведара: ссылка на /planning только с параметром режима, canonical варианта — /planning.
  '/field?mode=trail'];
const nav = () => `<nav>${NAV.map((p) => `<a href="${p}#top">${p}</a>`).join('')}</nav>`;

function page(o: { title: string; desc?: string; canonicalIn?: 'head' | 'body' | 'none'; robots?: string[]; h1?: string; og?: string; path: string; streamed?: boolean; img?: string; ld?: string; links?: string[]; words?: number }): string {
  const base = `http://127.0.0.1:${port}`;
  const canon = `<link rel="canonical" href="${base}${o.path}">`;
  const robots = (o.robots ?? ['index, follow']).map((r) => `<meta name="robots" content="${r}">`).join('');
  // streamed — как Next 15 отдаёт метаданные ботам не из htmlLimitedBots: title и description в <body>.
  const titleDesc = `<title>${o.title}</title>` + (o.desc ? `<meta name="description" content="${o.desc}">` : '');
  return `<!doctype html><html lang="ru"><head>${o.streamed ? '' : titleDesc}`
    + `<meta name="viewport" content="width=device-width">`
    + (o.canonicalIn === 'head' || o.canonicalIn === undefined ? canon : '')
    + robots
    + `<meta property="og:title" content="${o.title}"><meta property="og:image" content="${o.og ?? '/og.jpg'}">`
    + `<script type="application/ld+json">${o.ld ?? '{"@type":"TouristAttraction","name":"Место","image":"https://example.org/a.jpg"}'}</script>`
    + `</head><body>${o.streamed ? titleDesc : ''}${o.canonicalIn === 'body' ? canon : ''}`
    // <title> внутри <svg> — подпись иконки, не второй заголовок страницы.
    + `<svg viewBox="0 0 1 1"><title>Иконка вулкана</title></svg>`
    // alt="" — декоративная картинка рядом с подписью (так и надо, WCAG); alt со словами — снимок.
    + `<img src="/og.jpg" alt=""><span>Кузьмич</span><img src="/og.jpg" alt="Кратер вулкана">`
    + (o.img ?? '') + nav() + (o.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join('')
    + `<h1>${o.h1 ?? o.title}</h1><p>${words(o.words ?? 220)}</p></body></html>`;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-audit-census-'));
  server = createServer((req, res) => {
    seenUA.push(String(req.headers['user-agent'] ?? ''));
    const base = `http://127.0.0.1:${port}`;
    const url = req.url ?? '/';
    const html = (body: string, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`); return; }
    if (url === '/sitemap.xml') {
      const locs = ['/places/good', '/places/body-canonical', '/routes/double-robots', '/routes/soft', '/routes/moved', '/operators/gone', '/places/cut', '/places/bad-og',
        '/places/streamed', '/places/limited', '/places/no-alt', '/places/og-head', '/places/bad-ld', '/places/orphan', '/places/long-title', '/list', '/places/deep',
        '/field', '/places/twin', '/places/twin-body', '/places/single', '/places/thin']
        .map((p) => `<url><loc>${base}${p}</loc></url>`).join('');
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
      return;
    }
    if (url === '/og.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end('jpg'); return; }
    // Как /api/images Ведара: публично только GET, HEAD — 401. Картинка при этом открывается.
    if (url === '/og-head.jpg') {
      if (req.method === 'HEAD') { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end('jpg'); return;
    }
    if (url === '/places/good' || url === '/') return html(page({ path: url, title: 'Вулкан Горелый — место на Камчатке', desc: DESC_OK, links: ['/places/twin?ref=x', '/places/twin-body?ref=x', '/places/single', '/places/thin'] }));
    // На эти две ведёт одна ссылка — с /places/good; /places/thin ещё и тонкая.
    if (url === '/places/single') return html(page({ path: url, title: 'Озеро Дальнее — одна ссылка', desc: DESC_OK + ' Одна.' }));
    if (url === '/places/thin') return html(page({ path: url, title: 'Мыс Тонкий', desc: DESC_OK + ' Тонкий.', words: 40 }));
    if (url === '/places/body-canonical') return html(page({ path: url, title: 'Озеро Толмачёва', desc: DESC_OK + ' Озеро.', canonicalIn: 'body' }));
    if (url === '/routes/double-robots') return html(page({ path: url, title: 'Мутновский', desc: DESC_OK + ' Маршрут.', robots: ['index, follow', 'noindex'] }));
    if (url === '/routes/soft') return html(page({ path: url, title: 'Маршрут не найден', desc: DESC_OK + ' Нет.' }));
    if (url === '/routes/moved') { res.writeHead(308, { location: `${base}/places/good` }); res.end(); return; }
    if (url === '/operators/gone') return html('<h1>нет</h1>', 404);
    if (url === '/places/cut') return html(page({ path: url, title: 'Курильское озеро', desc: DESC_CUT }));
    if (url === '/places/bad-og') return html(page({ path: url, title: 'Долина гейзеров', desc: DESC_OK + ' Долина.', og: '/missing.jpg' }));
    if (url === '/places/streamed') return html(page({ path: url, title: 'Вилючинский', desc: DESC_OK + ' Вилючинский.', streamed: true }));
    if (url === '/places/no-alt') return html(page({ path: url, title: 'Озеро Дальнее', desc: DESC_OK + ' Дальнее.', img: '<img src="/og.jpg">' }));
    // Заголовок ровно в предел (65 знаков) — не находка.
    if (url === '/places/og-head') return html(page({ path: url, title: 'Бухта Русская — медведи, косатки и морские котики: как добраться.', desc: DESC_OK + ' Бухта.', og: '/og-head.jpg' }));
    // На знак длиннее предела — находка.
    if (url === '/places/long-title') return html(page({ path: url, title: 'Вулкан Мутновский — фумаролы, ледник и кратер: что знать до выхода', desc: DESC_OK + ' Мутновский.' }));
    // Рейтинг при нуле отзывов — поисковик такую разметку отвергает.
    if (url === '/places/bad-ld') return html(page({ path: url, title: 'Озеро Кроноцкое', desc: DESC_OK + ' Кроноцкое.',
      ld: '{"@type":"TouristAttraction","name":"Озеро","aggregateRating":{"@type":"AggregateRating","ratingValue":4.5,"reviewCount":0}}' }));
    // Список: первая страница в sitemap, продолжения — нет (как /routes Ведара).
    if (url === '/list') return html(page({ path: url, title: 'Все места', desc: DESC_OK + ' Список.', links: ['/list?page=2', '/list?kind=x&page=2'] }));
    // canonical второй страницы — на первую: так делать нельзя (у продолжения своё содержимое), обход это называет.
    if (url === '/list?page=2') return html(page({ path: '/list', title: 'Все места — страница 2', desc: DESC_OK + ' Два.', links: ['/places/deep', '/list?page=3'] }));
    if (url === '/list?page=3') return html(page({ path: url, title: 'Все места — страница 3', desc: DESC_OK + ' Три.', links: ['/list?page=2'] }));
    // Отфильтрованный список — другой список: по нему перепись не ходит, иначе сирота перестала бы быть сиротой.
    if (url === '/list?kind=x&page=2') return html(page({ path: url, title: 'Фильтр', desc: DESC_OK + ' Фильтр.', links: ['/places/orphan'] }));
    if (url === '/places/deep') return html(page({ path: url, title: 'Озеро Кроноцкое — глубоко', desc: DESC_OK + ' Глубоко.' }));
    // Полевой экран: ссылки на него — только с параметром режима; вариант склеивается canonical'ом в <head>.
    if (url === '/field') return html(page({ path: url, title: 'Полевой экран', desc: DESC_OK + ' Поле.' }));
    if (url === '/field?mode=trail') return html(page({ path: '/field', title: 'Полевой экран', desc: DESC_OK + ' Поле.' }));
    // Двойники-обманки: ссылка тоже только с параметром, но вариант на адрес без параметров НЕ указывает —
    // у одного canonical на самого себя, у другого нужный canonical стоит в <body>, где поисковик его не берёт.
    if (url === '/places/twin' || url === '/places/twin-body') return html(page({ path: url, title: `Двойник ${url}`, desc: DESC_OK + ` ${url}.` }));
    if (url === '/places/twin?ref=x') return html(page({ path: url, title: 'Двойник с параметром', desc: DESC_OK + ' Реф.' }));
    if (url === '/places/twin-body?ref=x') return html(page({ path: '/places/twin-body', title: 'Двойник, canonical в body', desc: DESC_OK + ' Тело.', canonicalIn: 'body' }));
    // На сироту не ссылается ни одна страница — она известна только из sitemap.
    if (url === '/places/orphan') return html(page({ path: url, title: 'Вулкан Ключевской', desc: DESC_OK + ' Ключевской.' }));
    if (url === '/places/limited') {
      // Первый запрос — 429, как ограничитель сайта; повтор — страница.
      if (!limitedOnce) { limitedOnce = true; res.writeHead(429, { 'retry-after': '0' }); res.end('Too many requests'); return; }
      return html(page({ path: url, title: 'Халактырский пляж', desc: DESC_OK + ' Пляж.' }));
    }
    return html('<title>404</title>', 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

type CrawlIssue = { severity: string; what: string; urls: string[] };

async function audit(extra: string[] = []) {
  limitedOnce = false;
  const out = join(dir, `a-${Date.now()}.json`);
  const { stdout } = await run('python3', [SCRIPT, '--host', `127.0.0.1:${port}`, '--scheme', 'http', '--max-pages', '2',
    '--link-checks', '0', '--sitemap-census', '50', '--json', out, ...extra],
  { env: { ...process.env, SITE_AUDIT_PAUSE: '0' }, timeout: 60_000 });
  const json = JSON.parse(readFileSync(out, 'utf-8')) as {
    census: { checked: number; ok: number; rate_limited: number; issues: { what: string; count: number; examples: string[] }[];
      by_section: Record<string, Record<string, number>>; og_images: { bad: string[]; head_only: string[] };
      paged: { fetched: number; errors: string[] }; variants: { fetched: number; canonical_here: number; errors: string[] };
      single_inbound: { url: string; from: string | null; section: string }[] };
    issues: CrawlIssue[];
  };
  return { stdout, census: json.census, crawl: json.issues };
}

const ORPHAN = 'сирота (ни одной ссылки ни со страниц sitemap, ни с продолжений списков, ни через адрес с параметрами)';

const hits = (c: { issues: { what: string; examples: string[] }[] }, what: string) =>
  (c.issues.find((i) => i.what === what)?.examples ?? []).map((e) => e.split(' ')[0].replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));

describe('перепись sitemap: каждый дефект назван, здоровое не тронуто', () => {
  it('проходит все адреса sitemap без перехода по редиректу', async () => {
    const { census } = await audit();
    expect(census.checked).toBe(22);
    expect(hits(census, 'не 200 в sitemap').sort()).toEqual(['/operators/gone', '/routes/moved']);
    // 429 — ждёт и повторяет, но счёт таких ответов называет.
    expect(census.rate_limited).toBe(1);
  }, 60_000);

  it('canonical вне <head> отличает от canonical в <head>', async () => {
    const { census } = await audit();
    expect(hits(census, 'canonical только вне <head>')).toEqual(['/places/body-canonical']);
    expect(hits(census, 'нет canonical')).toEqual([]);
  }, 60_000);

  it('title и description, отданные стримингом в <body>, названы; <title> иконки — не второй заголовок', async () => {
    const { census } = await audit();
    expect(hits(census, 'title вне <head>')).toEqual(['/places/streamed']);
    expect(hits(census, 'description вне <head>')).toEqual(['/places/streamed']);
    expect(hits(census, 'title больше одного')).toEqual([]);
  }, 60_000);

  it('два meta robots, soft-404, оборванное описание, нерабочий og:image', async () => {
    const { census } = await audit();
    expect(hits(census, 'meta robots больше одного')).toEqual(['/routes/double-robots']);
    expect(hits(census, 'noindex на адресе из sitemap')).toEqual(['/routes/double-robots']);
    expect(hits(census, 'soft-404 (200 с «не найден»)')).toEqual(['/routes/soft']);
    expect(hits(census, 'description оборван посреди слова')).toEqual(['/places/cut']);
    expect(census.og_images.bad.map((b) => b.split(' ')[0].replace(/^http:\/\/127\.0\.0\.1:\d+/, ''))).toEqual(['/missing.jpg']);
  }, 60_000);

  it('alt="" у декоративной картинки — не находка; картинка вовсе без alt — находка', async () => {
    const { census } = await audit();
    expect(hits(census, 'картинки без alt')).toEqual(['/places/no-alt']);
  }, 60_000);

  it('og:image, закрытый только на HEAD, открывается GET и не числится сломанным', async () => {
    const { census } = await audit();
    const strip = (x: string) => x.split(' ')[0].replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    expect(census.og_images.bad.map(strip)).toEqual(['/missing.jpg']);
    expect(census.og_images.head_only.map(strip)).toEqual(['/og-head.jpg']);
  }, 60_000);

  it('рейтинг без отзывов в JSON-LD назван, исправная разметка — нет', async () => {
    const { census } = await audit();
    expect(hits(census, 'JSON-LD с ошибкой')).toEqual(['/places/bad-ld']);
    const ex = census.issues.find((i) => i.what === 'JSON-LD с ошибкой')?.examples[0] ?? '';
    expect(ex).toContain('рейтинг без отзывов');
  }, 60_000);

  it('title длиннее предела проекта назван; ровно в предел — нет', async () => {
    const { census } = await audit();
    expect(hits(census, 'title длиннее 65 знаков')).toEqual(['/places/long-title']);
  }, 60_000);

  it('сирота — страница, на которую не ссылается ни одна другая', async () => {
    const { census } = await audit();
    expect(hits(census, ORPHAN).sort()).toEqual(['/places/orphan', '/places/twin', '/places/twin-body']);
  }, 60_000);

  it('обход: вариант с параметром, склеенный с адресом, — не находка; продолжение списка, склеенное с первой, — находка', async () => {
    const { crawl } = await audit(['--max-pages', '60']);
    const strip = (x: string) => x.replace(/http:\/\/127\.0\.0\.1:\d+/g, '');
    const elsewhere = crawl.find((i) => i.what === 'canonical указывает на другой адрес');
    expect(elsewhere?.severity).toBe('high');
    expect((elsewhere?.urls ?? []).map(strip)).toEqual(['/list?page=2 -> /list']);
  }, 60_000);

  it('ссылки только через адрес с параметрами: не сирота, если canonical варианта в <head> ведёт сюда', async () => {
    const { census } = await audit();
    expect(hits(census, 'ссылки только через адрес с параметрами (его canonical ведёт сюда)')).toEqual(['/field']);
    // canonical прочитан у каждого варианта, а не предположен: склеил один из трёх.
    expect(census.variants).toEqual({ fetched: 3, canonical_here: 1, errors: [] });
  }, 60_000);

  it('страницы-продолжения списков — источники ссылок: место со 2-й страницы не сирота, а «глубоко»', async () => {
    const { census } = await audit();
    expect(hits(census, 'ссылки только со страниц-продолжений списков (?page=N)')).toEqual(['/places/deep']);
    // Обойдены ровно продолжения: 2-я и 3-я; отфильтрованный список — нет.
    expect(census.paged).toEqual({ fetched: 2, errors: [] });
  }, 60_000);

  it('чистая страница не попадает ни в одну находку', async () => {
    const { census } = await audit();
    // Адрес находки — первое слово примера; «→ 308 …/places/good» у редиректа — его цель, не находка.
    for (const i of census.issues) {
      expect({ what: i.what, hit: hits(census, i.what).includes('/places/good') }).toEqual({ what: i.what, hit: false });
    }
    expect(census.ok).toBe(20);
  }, 60_000);

  it('разделы считаются по первому сегменту пути', async () => {
    const { census } = await audit();
    expect(census.by_section['/places/*'].urls).toBe(16);
    expect(census.by_section['/routes/*']['soft-404 (200 с «не найден»)']).toBe(1);
  }, 60_000);
});

describe('одна входящая ссылка и число слов у тонкой — названы (14.10)', () => {
  const strip = (u: string | null) => (u ?? '').replace(/^http:\/\/127\.0\.0\.1:\d+/, '');

  it('страница, на которую ведёт одна ссылка, названа вместе с единственным источником', async () => {
    const { census } = await audit();
    const single = census.single_inbound.map((x) => [strip(x.url), strip(x.from), x.section]);
    expect(single).toContainEqual(['/places/single', '/places/good', '/places/*']);
    expect(single).toContainEqual(['/places/thin', '/places/good', '/places/*']);
    // На здоровую страницу ссылаются все — её в списке нет.
    expect(single.map((x) => x[0])).not.toContain('/places/good');
  }, 60_000);

  it('в отчёте — раздел и «адрес ← источник»; у тонкой — число слов', async () => {
    const md = join(dir, `r-${Date.now()}.md`);
    await run('python3', [SCRIPT, '--host', `127.0.0.1:${port}`, '--scheme', 'http', '--max-pages', '2',
      '--link-checks', '0', '--sitemap-census', '50', '--census-md', md],
    { env: { ...process.env, SITE_AUDIT_PAUSE: '0' }, timeout: 60_000 });
    const text = readFileSync(md, 'utf-8');
    expect(text).toMatch(/- одна входящая ссылка — \d+ \(\/places\/\* \d+/);
    expect(text).toContain('  - /places/single ← /places/good');
    const thin = text.split('\n').find((l) => l.includes('/places/thin (')) ?? '';
    expect(thin).toMatch(/\/places\/thin \(\d+ слов\)/);
  }, 60_000);
});

describe('заголовок бота — только у себя', () => {
  it('на локальной проверке скрипт приходит с заголовком Googlebot', async () => {
    seenUA.length = 0;
    await audit(['--ua', 'googlebot']);
    expect(seenUA.length).toBeGreaterThan(0);
    expect(seenUA.every((u) => u.includes('Googlebot/2.1'))).toBe(true);
  }, 60_000);

  it.each([
    ['https', 'example.com'],
    ['http', 'example.com'],
    ['https', 'vedarai.ru.example.com'],
  ])('на чужом домене (%s://%s) с заголовком бота отказывается до первого запроса', async (scheme, host) => {
    const r = await run('python3', [SCRIPT, '--host', host, '--scheme', scheme, '--ua', 'googlebot'], { timeout: 20_000 })
      .then(() => ({ code: 0, stdout: '' }), (e: { code?: number; stdout?: string }) => ({ code: e.code ?? -1, stdout: e.stdout ?? '' }));
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('только для vedarai.ru');
  }, 30_000);
});

describe('предел заголовка — один на проект и инструмент', () => {
  it('TITLE_LIMIT скрипта равен TITLE_LIMIT из lib/seo/title-fit', async () => {
    const { TITLE_LIMIT } = await import('@/lib/seo/title-fit');
    const py = execFileSync('python3', ['-c',
      'import importlib.util,sys; s=importlib.util.spec_from_file_location("sa", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.TITLE_LIMIT)',
      SCRIPT], { encoding: 'utf-8' }).trim();
    expect(Number(py)).toBe(TITLE_LIMIT);
  });
});

describe('jsonld_problems: правила разметки — вызовом на граничных данных', () => {
  const cases: Array<[string, unknown, string[]]> = [
    ['исправная разметка', { '@type': 'TouristTrip', name: 'Тур', image: 'https://vedarai.ru/a.jpg',
      offers: { '@type': 'Offer', price: 5000, priceCurrency: 'RUB' } }, []],
    ['Offer без валюты', { '@type': 'Product', offers: { '@type': 'Offer', price: 5000 } }, ['Offer без price/priceCurrency']],
    ['AggregateOffer без нижней цены', { '@type': 'AggregateOffer', priceCurrency: 'RUB' }, ['AggregateOffer без lowPrice/priceCurrency']],
    ['крошка без адреса в середине', { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная' },
      { '@type': 'ListItem', position: 2, name: 'Маршруты', item: 'https://vedarai.ru/routes' }] }, ['крошка без адреса']],
    ['последняя крошка без адреса — можно', { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: 'https://vedarai.ru' },
      { '@type': 'ListItem', position: 2, name: 'Маршрут' }] }, []],
    ['относительная картинка', { '@type': 'Organization', logo: '/images/logo.png' }, ['относительный адрес в «logo»']],
    ['мусор из шаблона', { '@type': 'Place', name: 'undefined' }, ['мусор из шаблона (undefined/NaN/[object Object])']],
    ['рейтинг строкой без отзывов', { '@graph': [{ '@type': 'AggregateRating', ratingValue: '4.5' }] }, ['рейтинг без отзывов или без оценки']],
  ];
  const run = (blocks: string[]) => JSON.parse(execFileSync('python3', ['-c',
    'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("sa", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.jsonld_problems(json.loads(sys.argv[2]))))',
    SCRIPT, JSON.stringify(blocks)], { encoding: 'utf-8' })) as string[];

  it.each(cases)('%s', (_name, ld, want) => {
    expect(run([JSON.stringify(ld)])).toEqual(want);
  });

  it('битый JSON — так и сказано, а не «ошибок нет»', () => {
    expect(run(['{"@type": "Place", '])).toEqual(['JSON-LD не разбирается']);
  });
});

describe('canonical_elsewhere: canonical на другой адрес — вызовом на граничных адресах', () => {
  const B = 'https://vedarai.ru';
  const cases: Array<[string, string, string, boolean]> = [
    // Прогон 7 (14.10): режим полевого экрана читается в браузере, серверный HTML один — склейка задумана.
    ['вариант с параметром → тот же путь без них', `${B}/planning?mode=trail`, `${B}/planning`, false],
    ['несколько параметров → тот же путь', `${B}/planning?mode=trail&obs=1`, `${B}/planning`, false],
    ['canonical на себя', `${B}/places/x?ref=1`, `${B}/places/x?ref=1`, false],
    ['canonical нет — это другая находка', `${B}/places/x`, '', false],
    // Продолжение списка склеивать с первой страницей нельзя: у него своё содержимое.
    ['?page=2 → первая страница списка', `${B}/places?page=2`, `${B}/places`, true],
    ['вариант → другой путь', `${B}/planning?mode=trail`, `${B}/planner`, true],
    ['вариант → тот же путь с другим параметром', `${B}/a?x=1`, `${B}/a?y=2`, true],
    ['адрес без параметров → другой путь', `${B}/routes/a`, `${B}/places/a`, true],
  ];
  const call = (final: string, canonical: string) => execFileSync('python3', ['-c',
    'import importlib.util,sys; s=importlib.util.spec_from_file_location("sa", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.canonical_elsewhere(sys.argv[2], sys.argv[3]))',
    SCRIPT, final, canonical], { encoding: 'utf-8' }).trim();

  it.each(cases)('%s', (_name, final, canonical, want) => {
    expect(call(final, canonical)).toBe(want ? 'True' : 'False');
  });
});
