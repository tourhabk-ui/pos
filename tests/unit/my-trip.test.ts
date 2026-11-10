/**
 * tests/unit/my-trip.test.ts
 *
 * «Моя поездка» в чате Кузьмича (#2970, владелец 10.11). Сторож вызовом:
 * какая реплика её открывает, что человек читает в ответе при каждом
 * исходе, и что кнопка в Telegram появляется только у чата с заявкой.
 * Чтение заявок чата на настоящем PostgreSQL — request-chat.pg (блок 1416).
 */
import { describe, it, expect } from 'vitest';
import { isMyTripAsk, MY_TRIP_BUTTON } from '@/lib/requests/my-trip-ask';
import { classifyCodeFirst } from '@/lib/kuzmich/code-first';
import { myTripText, MY_TRIP_NONE_TEXT, MY_TRIP_FAILED_TEXT, MY_TRIP_SITUATION_DAYS, type MyTripItem } from '@/lib/requests/my-trip';
import { touristReplyMarkup } from '@/lib/telegram/tourist-keyboard';

describe('какая реплика открывает «Мою поездку»', () => {
  it.each(['Моя поездка', 'моя поездка', 'МОЯ ПОЕЗДКА!', 'мои заявки?', 'Моя заявка', 'что с заявкой', 'Что с моей заявкой?', 'статус заявки', 'мои поездки'])(
    '«%s» — да', (t) => expect(isMyTripAsk(t)).toBe(true),
  );

  it.each([
    'моя поездка на Авачинский в июле — сколько стоит?',
    'хочу оставить заявку',
    'заявка',
    'помогите, моя поездка сорвалась, мы заблудились',
    'поездка',
  ])('«%s» — нет: это вопрос модели или беда, не список', (t) => expect(isMyTripAsk(t)).toBe(false));

  it('кнопка шлёт ровно ту реплику, которую узнаёт разбор', () => {
    expect(isMyTripAsk(MY_TRIP_BUTTON)).toBe(true);
  });

  it('код раньше модели отвечает списком — и посреди черновика заявки', () => {
    expect(classifyCodeFirst('Моя поездка', false)).toEqual({ kind: 'my_trip' });
    expect(classifyCodeFirst('мои заявки', true)).toEqual({ kind: 'my_trip' });
    expect(classifyCodeFirst('Расскажи про мою поездку на вулкан', false)).toEqual({ kind: 'none' });
  });
});

describe('ответ человеку', () => {
  const item = (over: Partial<MyTripItem>): MyTripItem => ({
    what: 'Сплав по Быстрой', date: '2026-11-14', human: 'Оператор ещё не ответил.', situation: { kind: 'none' }, ...over,
  });

  it('заявок в чате нет — как привязать заявку с сайта, без поиска по телефону', () => {
    expect(myTripText({ outcome: 'none' })).toBe(MY_TRIP_NONE_TEXT);
    expect(MY_TRIP_NONE_TEXT).toMatch(/код заявки/);
    expect(MY_TRIP_NONE_TEXT).not.toMatch(/телефон/i);
  });

  it('сбой чтения — «не прочитался», а не «заявок нет»', () => {
    const t = myTripText({ outcome: 'failed' });
    expect(t).toBe(MY_TRIP_FAILED_TEXT);
    expect(t).not.toMatch(/заявок пока нет/);
  });

  it('заявки: что, дата, статус словами и обстановка — каждым исходом своими словами', () => {
    const t = myTripText({ outcome: 'ok', items: [
      item({ situation: { kind: 'line', date: '2026-11-12', text: 'есть риски — штормовое предупреждение.' } }),
      item({ what: 'Гостевой дом «Кутха»', date: '2026-12-20', human: 'Хозяин ответил.', situation: { kind: 'later' } }),
      item({ what: null, date: null, human: 'Заявка у оператора.', situation: { kind: 'unchecked' } }),
    ] });
    expect(t).toMatch(/^Ваши заявки в этом чате:/);
    expect(t).toContain('1. Сплав по Быстрой, 14.11.2026\nОператор ещё не ответил.\nОбстановка на 12.11.2026: есть риски — штормовое предупреждение.');
    expect(t).toContain(`2. Гостевой дом «Кутха», 20.12.2026\nХозяин ответил.\nОбстановку на дату поездки покажу ближе к ней — за ${MY_TRIP_SITUATION_DAYS} дней.`);
    expect(t).toContain('3. Заявка\nЗаявка у оператора.\nОбстановку на дату поездки сейчас не проверил — это не значит, что всё спокойно.');
    expect(t).toMatch(/Экстренный вызов — 112\.$/);
  });

  it('одна заявка — «Ваша заявка», без строки обстановки, когда сказать нечего', () => {
    const t = myTripText({ outcome: 'ok', items: [item({})] });
    expect(t.startsWith('Ваша заявка в этом чате:')).toBe(true);
    expect(t).not.toMatch(/Обстановк/);
  });
});

describe('клавиатура туриста в Telegram', () => {
  it('«Моя поездка» — только у чата с заявкой, первой строкой', () => {
    const texts = (m: ReturnType<typeof touristReplyMarkup>) => m.keyboard.flat().map((b) => b.text);
    expect(texts(touristReplyMarkup(false))).not.toContain(MY_TRIP_BUTTON);
    expect(touristReplyMarkup(true).keyboard[0]).toEqual([{ text: MY_TRIP_BUTTON }]);
    expect(texts(touristReplyMarkup(true)).slice(1)).toEqual(texts(touristReplyMarkup(false)));
  });
});
