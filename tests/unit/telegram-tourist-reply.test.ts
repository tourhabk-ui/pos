/**
 * Каталог в ответе бота: даты заезда из базы, не календарь «в июле всё открыто».
 */
import { describe, expect, it } from 'vitest';
import { emphasizeTripDays } from '@/lib/telegram/kuzmich-format';
import { catalogFacts, seasonOverlaps, type CatalogTour } from '@/lib/telegram/tourist-tours';
import { enqueueTelegramChat, webhookAwaitsHandler } from '@/lib/telegram/update-lane';
import { matchTouristButton, touristRentalText, touristReplyMarkup } from '@/lib/telegram/tourist-keyboard';

const FIVE: CatalogTour = {
  id: 7,
  slug: 'pyat-dney',
  title: 'Пять дней по Камчатке',
  base_price: 180000,
  price_unit: 'per_person',
  multi_day_count: 5,
  season_start: '2027-08-25',
  season_end: '2027-09-30',
};

describe('даты тура против месяца в вопросе', () => {
  it('июль не получает заезд 25 августа — 30 сентября', () => {
    expect(seasonOverlaps(FIVE, [7])).toBe(false);
    const facts = catalogFacts('Что посмотреть за 5 дней в июле?', { ok: true, tours: [FIVE] });
    expect(facts.note).toContain('25 августа 2027');
    expect(facts.note).toContain('30 сентября 2027');
    expect(facts.note).toContain('июле');
    expect(facts.note).toContain('180');
    expect(facts.html).toContain('https://vedarai.ru/catalog/tours/pyat-dney');
    expect(facts.html).not.toMatch(/от 0 /);
    expect(facts.inline?.inline_keyboard[0]?.[0]?.url).toBe('https://vedarai.ru/catalog/tours/pyat-dney');
  });

  it('лето называет месяцы, которых в сезоне нет, и не выдумывает цену', () => {
    const facts = catalogFacts('что посмотреть за 5 дней летом', { ok: true, tours: [FIVE] });
    expect(facts.note).toContain('июне');
    expect(facts.note).toContain('июле');
    expect(facts.note).toContain('25 августа 2027');
    const bare = catalogFacts('что посмотреть за 5 дней летом', {
      ok: true,
      tours: [{ ...FIVE, base_price: null }],
    });
    expect(bare.note).toContain('цена не указана');
    expect(bare.note).not.toMatch(/от 0/);
  });

  it('аренда авто не подмешивает туры', () => {
    const facts = catalogFacts('Хочу арендовать авто', { ok: true, tours: [FIVE] });
    expect(facts.html).toBe('');
    expect(facts.inline).toBeUndefined();
  });

  it('каталог не прочитан — цены нет, а не ноль', () => {
    const facts = catalogFacts('покажи туры на 5 дней', { ok: false });
    expect(facts.note).toContain('не прочитан');
    expect(facts.note).not.toMatch(/\d{3,}/);
  });
});

describe('клавиатура туриста', () => {
  it('пять кнопок и аренда без кабинета', () => {
    const labels = touristReplyMarkup().keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Подобрать тур', 'Погода', 'Аренда авто', 'Операторы', 'Задать вопрос']);
    expect(matchTouristButton('  погода ')).toBe('Погода');
    expect(matchTouristButton('покажи туры')).toBeNull();
    const rental = touristRentalText(new Date('2026-10-24T12:00:00Z'));
    expect(rental).toContain('не показывается');
    expect(rental).not.toMatch(/Лагуна|FLO/i);
    expect(rental).not.toContain('подключён к оператору');
  });
});

describe('дни в ответе', () => {
  it('строка дня жирная, переносы на месте', () => {
    const html = emphasizeTripDays('Сначала сезон.\nДень 1 — берег\nДень 2 — сопка');
    expect(html).toContain('<b>День 1 — берег</b>');
    expect(html).toContain('<b>День 2 — сопка</b>');
    expect(html).toContain('\n');
  });
});

describe('очередь чата', () => {
  it('второй ход не обгоняет первый', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const key = `chat-${Date.now()}`;
    const first = enqueueTelegramChat(key, async () => {
      order.push('start-1');
      await gate;
      order.push('end-1');
    });
    const second = enqueueTelegramChat(key, async () => {
      order.push('end-2');
    });
    await Promise.resolve();
    expect(order).toEqual(['start-1']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start-1', 'end-1', 'end-2']);
  });

  it('на сервере вебхук не ждёт модель', () => {
    expect(webhookAwaitsHandler({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
