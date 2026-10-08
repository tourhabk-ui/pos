/**
 * Сторож: посты в каналах собраны по одному стандарту (решение владельца
 * 27.09: «жирный заголовок, гиперссылка, цитирование — пусть посты будут на
 * уровне»). Заголовок жирный и ведёт на страницу, «что и где» — курсивом,
 * факты — плашкой цитаты, эмодзи нет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  channelHeadline, channelKicker, channelFacts, channelLink, channelPost,
} from '@/lib/notifications/channel-style';
import { buildTourPostText } from '@/lib/notifications/tour-channel-post';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('детали стиля', () => {
  it('заголовок жирный и ведёт на страницу; адрес и текст экранированы', () => {
    expect(channelHeadline('Озеро <А> & Б', 'https://vedarai.ru/x?a=1&b=2'))
      .toBe('<b><a href="https://vedarai.ru/x?a=1&amp;b=2">Озеро &lt;А&gt; &amp; Б</a></b>');
    expect(channelHeadline('Без ссылки')).toBe('<b>Без ссылки</b>');
  });

  it('пустые части не рисуются вовсе', () => {
    expect(channelKicker([null, '  ', undefined])).toBeNull();
    expect(channelFacts([null, ''])).toBeNull();
    expect(channelKicker(['Озеро', null, 'Треккинг'])).toBe('<i>Озеро · Треккинг</i>');
    expect(channelFacts(['2 дн.', '<b>10 000 ₽</b>'])).toBe('<blockquote>2 дн.\n<b>10 000 ₽</b></blockquote>');
  });

  it('пост — блоки через пустую строку, пропуски выпадают', () => {
    expect(channelPost([['<b>T</b>', null], null, 'текст', channelLink('Далее', 'https://e.x')]))
      .toBe('<b>T</b>\n\nтекст\n\n<a href="https://e.x">Далее</a>');
  });
});

describe('тур — по стандарту', () => {
  const text = buildTourPostText({
    id: 7, title: 'Сплав по Быстрой', activity_type: 'rafting', location: 'Мильковский район',
    short_description: 'Два дня на реке с рыбалкой.', duration_hours: null, multi_day_count: 2,
    max_participants: 8, difficulty: 'easy', base_price: 25000, price_unit: 'per_person',
    operator_name: 'Оператор Тест',
  } as unknown as Parameters<typeof buildTourPostText>[0], 'https://vedarai.ru');

  it('заголовок ведёт на тур, факты и цена — плашкой, в конце — ссылка на бронь', () => {
    expect(text.startsWith('<b><a href="https://vedarai.ru/catalog/tours/7">Сплав по Быстрой</a></b>\n<i>')).toBe(true);
    expect(text).toMatch(/<blockquote>[\s\S]*<b>25 000 ₽<\/b>[\s\S]*Оператор: Оператор Тест<\/blockquote>/);
    expect(text.endsWith('<a href="https://vedarai.ru/catalog/tours/7">Подробности и заявка оператору</a>')).toBe(true);
  });
});

describe('все шаблоны канала пользуются стандартом', () => {
  const tg = read('lib/notifications/telegram-channel.ts');
  const route = tg.slice(tg.indexOf('export async function postRouteToChannel'), tg.indexOf('export async function postOperatorToChannel'));
  const operator = tg.slice(tg.indexOf('export async function postOperatorToChannel'), tg.indexOf('KUZMICH_CHANNEL_VOICE'));

  it('маршрут, оператор, тур и место собираются channelHeadline', () => {
    expect(route).toContain('channelHeadline(r.title');
    expect(operator).toContain('channelHeadline(p.name');
    expect(read('lib/notifications/tour-channel-post.ts')).toContain('channelHeadline(row.title');
    expect(read('lib/notifications/place-post.ts')).toContain('channelHeadline(src.title');
  });

  it('эмодзи и прежнего имени «TourHab» в шаблонах нет', () => {
    const EMOJI = /\p{Extended_Pictographic}/u;
    expect(EMOJI.test(route)).toBe(false);
    expect(EMOJI.test(operator)).toBe(false);
    expect(operator).not.toMatch(/TourHab/);
  });
});
