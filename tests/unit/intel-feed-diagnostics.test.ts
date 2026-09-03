// @vitest-environment node
/**
 * Пустая лента разведки называет себя поимённо (03.09).
 *
 * Прогон 18:18 UTC: «competitors: 2 из 2 лент ответили и пусты»,
 * «travel_industry: 5 из 5 лент ответили и пусты». Это класс беды; чинят
 * ленту, а у пустоты три лица: HTML вместо ленты (бот-заслон, съехавший
 * адрес), лента без записей, чужой формат. Из класса их не различить.
 *
 * Сторож держит: род тела определяется по корневому тегу; HTTP-отказ ленты
 * — исключение, а не «ответила и пуста»; разборщик не выбрасывает `<item>`
 * и `<entry>` с атрибутами; причина пустоты называет ленты.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyFeedBody, describeFeedBody, judgeEmptyGather,
} from '@/lib/agents/intel-gather-census';
import { parseRssItems, parseAtomEntries } from '@/lib/services/intelligence-monitor.service';

const SRC = readFileSync(join(process.cwd(), 'lib/services/intelligence-monitor.service.ts'), 'utf-8');

describe('род тела ленты — по корневому тегу', () => {
  it('RSS, Atom, HTML, JSON, пусто, прочее', () => {
    expect(classifyFeedBody('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>')).toBe('rss');
    expect(classifyFeedBody('<rdf:RDF xmlns="http://purl.org/rss/1.0/"></rdf:RDF>')).toBe('rss');
    expect(classifyFeedBody('<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toBe('atom');
    expect(classifyFeedBody('<!DOCTYPE html><html><body>Just a moment...</body></html>')).toBe('html');
    expect(classifyFeedBody('{"items":[]}')).toBe('json');
    expect(classifyFeedBody('   ')).toBe('empty');
    expect(classifyFeedBody('hello')).toBe('other');
  });

  it('описание пустой ленты — хост, код, размер, что пришло', () => {
    expect(describeFeedBody('ator.ru', 200, 54 * 1024, 'html')).toBe('ator.ru: HTTP 200, 54 КБ, HTML вместо ленты');
    expect(describeFeedBody('rata-news.ru', 200, 512, 'rss')).toBe('rata-news.ru: HTTP 200, 512 Б, RSS без записей');
  });
});

describe('разборщик не выбрасывает записи с атрибутами', () => {
  it('<item rdf:about> и <entry xml:lang> — тоже записи', () => {
    const rss = '<rss><channel><item rdf:about="x"><title>A</title><link>https://a</link></item></channel></rss>';
    expect(parseRssItems(rss)).toHaveLength(1);
    const atom = '<feed><entry xml:lang="ru"><title>B</title><link href="https://b"/></entry></feed>';
    expect(parseAtomEntries(atom)).toHaveLength(1);
  });
});

describe('отказ и пустота — разные исходы', () => {
  it('HTTP-отказ ленты — исключение, а не «ответила и пуста»', () => {
    expect(SRC).toMatch(/if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\)/);
    expect(SRC).not.toMatch(/if \(!res\.ok\) return \[\];\s*\n\s*const xml/);
  });

  it('пустая лента попадает в перепись поимённо', () => {
    expect(SRC).toMatch(/describeFeedBody\(host, feed\.status, feed\.bytes, feed\.kind\)/);
    expect(SRC).toMatch(/census\.empties!\.push\(result\.value\.empty\)/);
  });

  it('причина пустоты называет ленты, а не только класс', () => {
    const v = judgeEmptyGather({
      attempted: 2, answered: 2, failed: 0, failures: [],
      empties: ['ator.ru: HTTP 200, 54 КБ, HTML вместо ленты', 'rata-news.ru: HTTP 200, 3 КБ, RSS без записей'],
    });
    expect(v.outcome).toBe('no_signals');
    expect(v.reason).toContain('ator.ru: HTTP 200, 54 КБ, HTML вместо ленты');
    expect(v.reason).toContain('rata-news.ru');
  });

  it('без переписи пустых — прежняя формулировка, не падение', () => {
    const v = judgeEmptyGather({ attempted: 3, answered: 3, failed: 0, failures: [] });
    expect(v.reason).toBe('3 из 3 лент ответили и пусты');
  });
});
