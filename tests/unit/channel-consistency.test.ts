/**
 * Каналы говорят одно и то же — или расхождение видно.
 *
 * Платформа рассказывает о турах трижды: каталогом людям, картой сайта
 * поисковикам, файлом llms.txt и протоколом MCP агентам. Источник один, код
 * разный, и расхождение никогда не падает — каждый канал по отдельности
 * отвечает 200 и выглядит исправным.
 *
 * Так было дважды, и оба раза находил владелец спустя недели: `get_tours`
 * отдавал «Туры не найдены» при живых карточках (#1048), карта сайта собиралась
 * на билде без базы и несла полсотни ссылок вместо сотен (#1049, #1053).
 *
 * Фикстуры — настоящие ответы прода, снятые пробой 10.08.
 */
import { describe, it, expect } from 'vitest';
import {
  mcpTourIds, urlTourIds, sitemapUrlCount, findDivergences, formatDivergences, isSecondCanon,
} from '@/lib/quality/channel-consistency';

/** Ответ MCP get_tours как он приходит с прода: текст для модели, не JSON. */
const MCP_BODY = `РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ (актуальные цены, называй по имени):
ID27: "Сплав по реке Быстрая" — Река Быстрая  тип:rafting  от 13 000 р/чел | Оп: Камчатка Семейный Рафтинг | Мест: 12 | Ближайшая дата: 1 июня
ID6: "Рыбалка на кижуча" — тип:fishing  от 25 000 р/чел | Оп: Камчатка Фишинг | Мест: 8`;

describe('ID вытаскиваются из каждого канала', () => {
  it('из ответа MCP — по метке ID, она же контракт для агента', () => {
    expect([...mcpTourIds(MCP_BODY)].sort()).toEqual(['27', '6']);
  });

  it('из ссылок каталога и маркетплейса', () => {
    const llms = 'см. https://vedarai.ru/catalog/tours/6 и /marketplace/tours/27';
    expect([...urlTourIds(llms)].sort()).toEqual(['27', '6']);
  });

  it('карта сайта считается по числу адресов', () => {
    expect(sitemapUrlCount('<url><loc>a</loc></url><url><loc>b</loc></url>')).toBe(2);
    expect(sitemapUrlCount('')).toBe(0);
  });

  it('посторонние числа за ID не принимаются', () => {
    expect(mcpTourIds('Мест: 12 | цена 13 000').size).toBe(0);
    expect(urlTourIds('/routes/12 /places/7').size).toBe(0);
  });
});

describe('расхождение видно в обе стороны', () => {
  it('тур есть у агента, но не в карте сайта', () => {
    const d = findDivergences([
      { channel: 'mcp', ids: new Set(['6', '27']) },
      { channel: 'sitemap', ids: new Set(['6']) },
    ]);
    expect(formatDivergences(d)).toContain('в mcp есть, в sitemap нет: 27');
  });

  it('и обратное — тур в каталоге, но агент о нём не знает', () => {
    const d = findDivergences([
      { channel: 'mcp', ids: new Set(['6']) },
      { channel: 'llms', ids: new Set(['6', '27']) },
    ]);
    expect(formatDivergences(d)).toContain('в llms есть, в mcp нет: 27');
  });

  it('совпадающие каналы молчат', () => {
    expect(findDivergences([
      { channel: 'mcp', ids: new Set(['6', '27']) },
      { channel: 'llms', ids: new Set(['27', '6']) },
      { channel: 'sitemap', ids: new Set(['6', '27']) },
    ])).toEqual([]);
  });

  it('пустой канал в сверку не идёт — это отдельная поломка', () => {
    // Иначе один упавший канал породил бы расхождения со всеми остальными и
    // утопил настоящую причину в списке ложных.
    const d = findDivergences([
      { channel: 'mcp', ids: new Set<string>() },
      { channel: 'llms', ids: new Set(['6', '27']) },
    ]);
    expect(d).toEqual([]);
  });
});

describe('второй канон домена распознаётся', () => {
  it('домен отдаёт содержимое вместо перенаправления — второй канон', () => {
    // Проба 10.08: tourhab.ru отвечает 200 и 37 475 байт с брендом «Ведар».
    expect(isSecondCanon(200, 37475)).toBe(true);
  });

  it('перенаправление на канонический — не находка', () => {
    expect(isSecondCanon(301, 0)).toBe(false);
    expect(isSecondCanon(308, 0)).toBe(false);
  });

  it('домен не отвечает — тоже не находка, это другой вопрос', () => {
    expect(isSecondCanon(404, 0)).toBe(false);
    expect(isSecondCanon(200, 0)).toBe(false);
  });
});
