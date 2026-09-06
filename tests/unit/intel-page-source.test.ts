/**
 * Сторож источника-страницы (06.09).
 *
 * Anthropic не публикует ленту вовсе — замер с прода: /news отдаёт HTML,
 * четыре RSS-адреса отвечают 404. Владелец просит сделать Anthropic главным
 * источником, значит читать надо страницу.
 *
 * Опасность здесь ровно одна и она из §4.0: разбор, который вернул ноль
 * записей, легко объявить «новостей нет». Ноль при сотне якорей — это смена
 * вёрстки, и сторож держит именно эту границу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractPageLinks, defaultPrefix } from '@/lib/services/intelligence/page-links';

const ROOT = join(__dirname, '../..');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const NEWS = 'https://www.anthropic.com/news';

const PAGE = `
<html><body>
  <nav><a href="/">Home</a><a href="#top">^</a></nav>
  <a href="/news">News</a>
  <a href="/news/claude-opus-5"><span>Announcements</span><h3>Claude Opus 5 доступен всем</h3><time>Sep 5</time></a>
  <a href="/news/claude-opus-5#hero">Claude Opus 5 доступен всем</a>
  <a href="/news/interpretability-update"><h3>Что мы узнали об интерпретируемости</h3></a>
  <a href="/careers/engineer">Инженерные вакансии</a>
  <a href="https://twitter.com/anthropicai">Twitter</a>
  <a href="/news/x">Ok</a>
  <a href="/news/closing-tag-with-space">Закрывающий тег с пробелом</a >
</body></html>`;

describe('источник-страница: разбор', () => {
  const got = extractPageLinks(PAGE, NEWS);

  it('префикс по умолчанию — путь самой страницы, записи лежат под ним', () => {
    expect(defaultPrefix(NEWS)).toBe('/news/');
    expect(got.prefix).toBe('/news/');
  });

  it('берёт записи и не берёт индекс, чужой раздел и чужой хост', () => {
    const urls = got.links.map((l) => l.url);
    expect(urls).toContain('https://www.anthropic.com/news/claude-opus-5');
    expect(urls).toContain('https://www.anthropic.com/news/interpretability-update');
    expect(urls).not.toContain('https://www.anthropic.com/news');
    expect(urls.some((u) => new URL(u).pathname.startsWith('/careers/'))).toBe(false);
    // Хост сверяется разбором, а не подстрокой: `includes('twitter.com')`
    // прошло бы и на `anthropic.com.twitter.com.evil/`, и CodeQL прав, что
    // помечает такую проверку (js/incomplete-url-substring-sanitization).
    const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
    expect(hosts).toEqual(['www.anthropic.com']);
  });

  it('якорь-дубль с решёткой не удваивает запись', () => {
    const opus = got.links.filter((l) => l.url.endsWith('/claude-opus-5'));
    expect(opus).toHaveLength(1);
  });

  it('теги выкидываются пробелом — слова не склеиваются', () => {
    const opus = got.links.find((l) => l.url.endsWith('/claude-opus-5'));
    expect(opus?.title).toContain('Announcements Claude Opus 5');
  });

  it('закрывающий тег читается как браузером: </a > тоже конец ссылки', () => {
    // js/bad-tag-filter. Требуй регулярка ровно `</a>` — текст всей страницы
    // после такой ссылки уехал бы в её заголовок.
    const link = got.links.find((l) => l.url.endsWith('/closing-tag-with-space'));
    expect(link?.title).toBe('Закрывающий тег с пробелом');
  });

  it('слишком короткий текст ссылки записью не считается', () => {
    expect(got.links.some((l) => l.url.endsWith('/news/x'))).toBe(false);
  });

  it('считает ВСЕ якоря — ноль записей при живых якорях отличим от пустой страницы', () => {
    expect(got.anchors).toBeGreaterThan(got.links.length);
    const dead = extractPageLinks('<html><body>nothing</body></html>', NEWS);
    expect(dead.anchors).toBe(0);
    expect(dead.links).toHaveLength(0);
  });
});

describe('источник-страница: проводка', () => {
  const service = strip(readFileSync(join(ROOT, 'lib/services/intelligence-monitor.service.ts'), 'utf8'));

  it('реестр знает тип page и складывает такие адреса отдельно от лент', () => {
    expect(service).toMatch(/source_type === 'page'/);
    expect(service).toMatch(/pages\s*\?\?=\s*\[\]/);
  });

  it('страницы попадают в перепись опроса, а не мимо неё', () => {
    expect(service).toMatch(/census\.attempted \+= pages\.length/);
  });

  it('пустой улов страницы называет число якорей — не выдаётся за тишину источника', () => {
    const empty = /page\.items\.length === 0[\s\S]{0,400}?якорей \$\{page\.anchors\}/;
    expect(service).toMatch(empty);
  });

  it('разбор страницы не зависит от ключей Firecrawl', () => {
    const fn = service.slice(service.indexOf('export async function fetchPage'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).not.toMatch(/firecrawl/i);
  });
});

describe('источник-страница: перепись лент', () => {
  const census = strip(readFileSync(join(ROOT, 'app/api/cron/intel-feeds-census/route.ts'), 'utf8'));

  it('страницы судятся разбором, а не формой тела ленты', () => {
    expect(census).toMatch(/source_type IN \('rss', 'page'\)/);
    expect(census).toMatch(/verdict: page\.items\.length > 0 \? 'page' : 'empty'/);
  });

  it('домен со страницей не числится молчащим', () => {
    expect(census).toMatch(/f\.verdict === 'feed' \|\| f\.verdict === 'page'/);
  });
});
