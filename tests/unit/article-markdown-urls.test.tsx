/**
 * Ссылки со скобками в адресе (аудит 21.11.2026): голый URL и [текст](адрес)
 * на статьи Википедии вроде «Елизово_(аэропорт)» не должны обрезаться на «(».
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseInline, parseArticleMarkdown, safeHref, takeBareUrl, takeMdLink } from '@/lib/articles/markdown';
import { ArticleMarkdown } from '@/components/articles/ArticleMarkdown';

const ELIZOVO = 'https://ru.wikipedia.org/wiki/Елизово_(аэропорт)';
const KLYUCHI = 'https://ru.wikipedia.org/wiki/Ключи_(Камчатский_край)';
const KOSATKA = 'https://ru.wikipedia.org/wiki/Косатка_(млекопитающее)';

describe('takeBareUrl: скобки в пути', () => {
  it('берёт статью Википедии целиком и оставляет хвостовую точку фразы', () => {
    expect(takeBareUrl(`${ELIZOVO}.`)).toBe(ELIZOVO);
    expect(takeBareUrl(`${KLYUCHI},`)).toBe(KLYUCHI);
    expect(takeBareUrl('https://example.com/foo)')).toBe('https://example.com/foo');
    expect(takeBareUrl('https://example.com/a_(b)_c.')).toBe('https://example.com/a_(b)_c');
  });
});

describe('takeMdLink: парные скобки в адресе', () => {
  it('не обрывает href на первой закрывающей скобке', () => {
    const md = takeMdLink(`[аэропорт](${ELIZOVO})`);
    expect(md?.href).toBe(ELIZOVO);
    expect(md?.text).toBe('аэропорт');
    expect(takeMdLink('[x](<https://ru.wikipedia.org/wiki/Елизово_(аэропорт)>)')?.href).toBe(ELIZOVO);
  });
});

describe('parseInline', () => {
  it('голый URL со скобками — ссылка на ту же статью, хвост «(…)» не отдельный текст', () => {
    for (const url of [ELIZOVO, KLYUCHI, KOSATKA]) {
      const nodes = parseInline(`См. ${url}`);
      const link = nodes.find((n) => n.t === 'link');
      expect(link, url).toEqual({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
      const leftover = nodes.filter((n) => n.t === 'text' && /^\(/.test(n.v));
      expect(leftover, url).toEqual([]);
    }
  });

  it('markdown-ссылка со скобками в адресе', () => {
    const nodes = parseInline(`[Елизово (аэропорт)](${ELIZOVO})`);
    expect(nodes).toEqual([{ t: 'link', href: ELIZOVO, c: [{ t: 'text', v: 'Елизово (аэропорт)' }] }]);
  });

  it('safeHref пропускает http(s) со скобками', () => {
    expect(safeHref(ELIZOVO)).toBe(ELIZOVO);
  });

  it('KVERT по HTTP и битая форма Госуслуги41 не становятся ссылкой и не остаются голым адресом', () => {
    expect(safeHref('http://kvert.febras.net/volc?lang=ru&name=Avachinsky')).toBeNull();
    expect(safeHref('https://gosuslugi41.ru/pgu/volcano_info.htm')).toBeNull();
    const nodes = parseInline('KVERT, ИВиС ДВО РАН: http://kvert.febras.net/volc?lang=ru&name=Avachinsky');
    expect(nodes).toEqual([{ t: 'text', v: 'KVERT, ИВиС ДВО РАН: ' }]);
  });
});

describe('рендер списка источников', () => {
  it('href не обрезан; у списка — перенос длинного URL; у таблицы — подсказка прокрутки', () => {
    const md = [
      '## Источники',
      '',
      `1. Википедия, «Елизово (аэропорт)»: ${ELIZOVO}`,
      `2. Википедия, «Ключи (Камчатский край)»: ${KLYUCHI}`,
      '',
      '| База | Перепад | Трассы |',
      '|---|---|---|',
      '| Морозная | 400 м | 5 |',
    ].join('\n');
    const html = renderToStaticMarkup(<ArticleMarkdown blocks={parseArticleMarkdown(md)} />);
    expect(html).toContain(`href="${ELIZOVO}"`);
    expect(html).toContain(`href="${KLYUCHI}"`);
    expect(html).not.toContain('href="https://ru.wikipedia.org/wiki/Елизово_"');
    expect(html).not.toContain('href="https://ru.wikipedia.org/wiki/Ключи_"');
    expect(html).toMatch(/overflow-wrap:anywhere|overflow-wrap: anywhere/);
    expect(html).toContain('data-table-scroll');
    expect(html).toContain('Таблица прокручивается вправо');
    expect(html).toContain('w-max');
  });
});
