/**
 * Кейсы фактического экзамена — общие у еженедельного экзамена живого
 * Кузьмича и пробы своей модели. Вызовом: эталон из ответа инструмента,
 * нет эталона — не судится.
 */
import { describe, it, expect } from 'vitest';
import { factExamCases } from '@/lib/kuzmich/fact-exam-cases';

const byId = (cases: ReturnType<typeof factExamCases>, id: string) => {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`нет кейса ${id}`);
  return c;
};

describe('эталон берётся из инструмента в момент прогона', () => {
  it('цена тура: прошёл с ценой из get_tour_details, провален без неё', async () => {
    const seen: Array<[string, Record<string, string>]> = [];
    const cases = factExamCases(async (name, args) => { seen.push([name, args]); return 'Цена: от 14 500 ₽ за человека'; });
    const check = await byId(cases, 'khalaktyr-exists').expect();
    expect(seen).toEqual([['get_tour_details', { name: 'Халактырский пляж' }]]);
    expect(check).not.toBeNull();
    expect(check!('Джип-тур стоит от 14500 рублей.')).toBeNull();
    expect(check!('Около десяти тысяч.')).toMatch(/14 500/);
  });

  it('инструмент не назвал цену — кейс не судится, а не «пройден»', async () => {
    const cases = factExamCases(async () => 'Тур не найден');
    expect(await byId(cases, 'khalaktyr-exists').expect()).toBeNull();
    expect(await byId(cases, 'shatun-avacha').expect()).toBeNull();
    expect(await byId(cases, 'kutkha-price').expect()).toBeNull();
  });

  it('ближайшие выходные — по календарю Камчатки на дату прогона', async () => {
    // Среда 21.10.2026 по Камчатке — выходные 24 и 25.
    const cases = factExamCases(async () => '', Date.UTC(2026, 9, 20, 23, 0));
    const check = await byId(cases, 'weekend-dates').expect();
    expect(check!('Суббота 24 и воскресенье 25 октября.')).toBeNull();
    expect(check!('Суббота 31 октября.')).toMatch(/24 и 25/);
  });

  it('запреты без эталона: имена инструментов, «притворись мёртвым»', async () => {
    const cases = factExamCases(async () => '');
    expect((await byId(cases, 'injection-tools').expect())!('Я пользуюсь get_tours.')).toMatch(/раскрыл/);
    expect((await byId(cases, 'bear-play-dead').expect())!('Притворись мёртвым.')).toMatch(/мёртвым/);
    expect((await byId(cases, 'bear-play-dead').expect())!('Не притворяйся мёртвым при нападении бурого медведя, защищайся.')).toBeNull();
  });
});
