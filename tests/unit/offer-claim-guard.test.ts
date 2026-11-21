/**
 * Цена, места и статус маршрута — только из вывода инструмента этого хода.
 */
import { describe, it, expect } from 'vitest';
import { guardOfferClaims, OFFER_HONEST_LINE, OFFER_PRICE_LINE, catalogToolRuns } from '@/lib/kuzmich/offer-claim-guard';
import { finishKuzmichAnswer } from '@/lib/kuzmich/answer-guards';
import type { ToolRun } from '@/lib/agents/eval/grounding';

describe('guardOfferClaims', () => {
  it('цену без инструмента заменяет честной строкой на месте цифры', () => {
    const out = guardOfferClaims('Тур стоит 28 000 ₽ за день.', []);
    expect(out.text).toBe(`Тур — ${OFFER_PRICE_LINE}.`);
    expect(out.text).toContain(OFFER_HONEST_LINE);
    expect(out.text).not.toContain('28 000');
    expect(out.removed).toHaveLength(1);
  });

  it('та же сумма в выводе инструмента — текст цел', () => {
    const runs: ToolRun[] = [{ name: 'get_tour', producedData: true, output: '«Рыбалка на кижуча» — 28 000 ₽ / чел./день' }];
    const text = 'Тур стоит 28 000 ₽ за день.';
    expect(guardOfferClaims(text, runs).text).toBe(text);
  });

  it('другая сумма, чем в инструменте, не проходит', () => {
    const runs: ToolRun[] = [{ name: 'get_tour', producedData: true, output: 'цена 28 000 ₽' }];
    const out = guardOfferClaims('Тур стоит 35 000 ₽.', runs).text;
    expect(out).toContain(OFFER_HONEST_LINE);
    expect(out).not.toContain('35 000');
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
    const out = guardOfferClaims('На эти даты мест нет.', null).text;
    expect(out).toContain(OFFER_HONEST_LINE);
    expect(out).not.toMatch(/мест нет\./);
  });

  it('«мест нет» опирается на вывод get_tour_availability', () => {
    const runs: ToolRun[] = [{ name: 'get_tour_availability', producedData: true, output: 'id 17: свободных мест нет (проверено сегодня)' }];
    const text = 'На эти даты мест нет.';
    expect(guardOfferClaims(text, runs).text).toBe(text);
  });

  it('«маршрут закрыт» без инструмента заменяется', () => {
    const out = guardOfferClaims('Сейчас маршрут закрыт из-за снега.', []).text;
    expect(out).toContain(OFFER_HONEST_LINE);
    expect(out).not.toMatch(/закрыт|снег/);
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

  it('имя тура рядом с выдуманной ценой остаётся, цена — нет', () => {
    const out = guardOfferClaims(
      'У «Местечка Камчатка» один тур: «Вулкан Толбачик (вертолёт)» — 165 000 ₽.',
      [],
    );
    expect(out.text).toContain('Вулкан Толбачик (вертолёт)');
    expect(out.text).toContain(OFFER_HONEST_LINE);
    expect(out.text).not.toContain('165 000');
  });

  it('витрина этого хода (catalog) обосновывает свою цену', () => {
    const text = '«К вулкану» — 180 000 ₽.';
    const runs = catalogToolRuns(text);
    expect(guardOfferClaims(text, runs).text).toBe(text);
  });

  it('пустой вывод инструмента цену не обосновывает', () => {
    const runs: ToolRun[] = [{ name: 'get_tour', producedData: false, output: 'не нашли. 12 000 ₽' }];
    const out = guardOfferClaims('Стоит 12 000 ₽.', runs).text;
    expect(out).toContain(OFFER_HONEST_LINE);
    expect(out).not.toContain('12 000');
  });
});

// Тест планировщика владельца 21.11: строка «не подтверждаю…» висела первой
// строкой ответа без контекста. Защита та же, место — рядом с цифрой.
describe('guardOfferClaims: строка рядом с цифрой, без ложных срабатываний', () => {
  it('строка встаёт на место цены в пункте плана, пункт и его смысл на месте', () => {
    const out = guardOfferClaims('- День 2. Горелый — 15 000 ₽ за человека (Андрей Запорожец).\n- День 3. Отдых.', []);
    expect(out.text).toBe(`- День 2. Горелый — ${OFFER_PRICE_LINE} (Андрей Запорожец).\n- День 3. Отдых.`);
  });

  it('переводы строк сохраняются: список не склеивается в одну строку', () => {
    const text = 'Два момента:\n- День 6 пустой, план соберётся полнее.\n- Тур стоит 99 000 ₽.';
    const out = guardOfferClaims(text, []).text;
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toMatch(/полнее\. -/);
  });

  it('цены из инструмента плана — текст цел (копейки в выводе, пробелы в ответе)', () => {
    const runs: ToolRun[] = [{ name: 'make_trip_plan', producedData: true, output: 'День 2. Горелый — от 15000.00 ₽/чел.\nИтого на группу из 2 чел.: 70 000 ₽' }];
    const text = 'День 2. Горелый — от 15 000 ₽ за человека. Итого на двоих 70 000 ₽.';
    const out = guardOfferClaims(text, runs);
    expect(out.text).toBe(text);
    expect(out.removed).toHaveLength(0);
  });

  it('«от 5 лет», «от 7 дней» — не цена: без инструмента предложение цело', () => {
    const text = 'Облёт подойдёт детям от 5 лет. Берите поездку от 7 дней.';
    expect(guardOfferClaims(text, []).text).toBe(text);
  });

  it('выдуманная цена рядом с подтверждённой — заменяется только она', () => {
    const runs: ToolRun[] = [{ name: 'make_trip_plan', producedData: true, output: 'Горелый — 15 000 ₽' }];
    const out = guardOfferClaims('Горелый — 15 000 ₽, бухта — 22 000 ₽.', runs).text;
    expect(out).toContain('15 000 ₽');
    expect(out).not.toContain('22 000');
    expect(out).toContain(OFFER_PRICE_LINE);
  });

  it('ни одного голого OFFER_HONEST_LINE отдельной строкой', () => {
    const answer = 'Собрал план.\n\nТур стоит 28 000 ₽.\n\nНа даты мест нет.\n\nМаршрут закрыт.';
    const out = guardOfferClaims(answer, []).text;
    for (const para of out.split(/\n+/)) expect(para.trim()).not.toBe(OFFER_HONEST_LINE);
    expect(out).not.toMatch(/28 000|мест нет\.|Маршрут закрыт/);
  });
});
