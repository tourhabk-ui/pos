/**
 * Цена, места и статус маршрута — только из вывода инструмента этого хода.
 */
import { describe, it, expect } from 'vitest';
import { guardOfferClaims, OFFER_HONEST_LINE } from '@/lib/kuzmich/offer-claim-guard';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import type { ToolRun } from '@/lib/agents/eval/grounding';

describe('guardOfferClaims', () => {
  it('цену без инструмента заменяет честной строкой', () => {
    const out = guardOfferClaims('Тур стоит 28 000 ₽ за день.', []);
    expect(out.text).toBe(OFFER_HONEST_LINE);
    expect(out.removed).toHaveLength(1);
  });

  it('та же сумма в выводе инструмента — текст цел', () => {
    const runs: ToolRun[] = [{ name: 'get_tour', producedData: true, output: '«Рыбалка на кижуча» — 28 000 ₽ / чел./день' }];
    const text = 'Тур стоит 28 000 ₽ за день.';
    expect(guardOfferClaims(text, runs).text).toBe(text);
  });

  it('другая сумма, чем в инструменте, не проходит', () => {
    const runs: ToolRun[] = [{ name: 'get_tour', producedData: true, output: 'цена 28 000 ₽' }];
    expect(guardOfferClaims('Тур стоит 35 000 ₽.', runs).text).toBe(OFFER_HONEST_LINE);
  });

  it('каталог в контексте промпта цену не обосновывает — нужен инструмент', () => {
    const finished = finishKuzmichAnswer({
      surface: 'web',
      answer: 'Стоит 15 000 ₽.',
      question: 'Сколько стоит?',
      toolRuns: [],
      context: 'Каталог: тур «Сплав» — 15 000 ₽',
    });
    expect(finished.text).toContain(OFFER_HONEST_LINE);
    expect(finished.text).not.toContain('15 000');
  });

  it('«мест нет» без инструмента заменяется', () => {
    expect(guardOfferClaims('На эти даты мест нет.', null).text).toBe(OFFER_HONEST_LINE);
  });

  it('«мест нет» опирается на вывод get_tour_availability', () => {
    const runs: ToolRun[] = [{ name: 'get_tour_availability', producedData: true, output: 'id 17: свободных мест нет (проверено сегодня)' }];
    const text = 'На эти даты мест нет.';
    expect(guardOfferClaims(text, runs).text).toBe(text);
  });

  it('«маршрут закрыт» без инструмента заменяется', () => {
    expect(guardOfferClaims('Сейчас маршрут закрыт из-за снега.', []).text).toBe(OFFER_HONEST_LINE);
  });

  it('статус маршрута из инструмента остаётся', () => {
    const runs: ToolRun[] = [{ name: 'get_place_info', producedData: true, output: 'перевал закрыт, снег, техника не проходит' }];
    const text = 'Сегодня перевал закрыт.';
    expect(guardOfferClaims(text, runs).text).toBe(text);
  });

  it('честный отказ «подтверждает оператор» не трогается', () => {
    const text = 'Цену и наличие мест подтверждает оператор.';
    expect(guardOfferClaims(text, []).text).toBe(text);
  });

  it('предложение без цены и мест остаётся, соседнее с выдуманной ценой — нет', () => {
    const out = guardOfferClaims('Озеро красивое. Тур стоит 40 000 ₽.', []);
    expect(out.text).toContain('Озеро красивое.');
    expect(out.text).toContain(OFFER_HONEST_LINE);
    expect(out.text).not.toContain('40 000');
  });

  it('пустой вывод инструмента цену не обосновывает', () => {
    const runs: ToolRun[] = [{ name: 'get_tour', producedData: false, output: 'не нашли. 12 000 ₽' }];
    expect(guardOfferClaims('Стоит 12 000 ₽.', runs).text).toBe(OFFER_HONEST_LINE);
  });
});
