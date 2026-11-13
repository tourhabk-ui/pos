// @vitest-environment node
/**
 * Сверка перевода: одно число и одно время в разных записях (13.11).
 *
 * Локальная проба сверки показала отказы годным переводам: «2 of us» → «Нас
 * двое», «19:00» → «7:00 p.m.» и «晚上7点», «1.5 hours» → «полтора часа».
 * Отказ сверки человек видит как «машинный перевод не получен» — в журнале
 * A2A, в заявке иностранца и в переписке заявки. Поэтому сверка обязана
 * узнавать одно и то же число в разных записях и при этом по-прежнему
 * отсекать потерянное и выдуманное.
 *
 * Судится поведение: функции сверки зовутся на парах «исходник — перевод».
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/providers', () => ({ callAIQualityOrNull: vi.fn(), callAIFastOrNull: vi.fn() }));

import {
  checkForeignTranslation, checkRussianTranslation, clockCanon, russianFractionNumbersOf, russianHourAlts,
} from '@/lib/ai/translate-text';
import { checkSegment, russianWordNumbersOf } from '@/lib/zh/fields';

const toRu = (source: string, ru: string) => checkRussianTranslation(source, ru);
const toEn = (source: string, out: string) => checkForeignTranslation(source, out, 'other');
const toZh = (source: string, out: string) => checkForeignTranslation(source, out, 'han');

describe('собирательные числительные — то же число', () => {
  it('«2 of us» → «Нас двое» годен; китайское «2个人» → «двое» тоже', () => {
    expect(toRu('Can we start at 9 am tomorrow? There are 2 of us.', 'Можем ли мы начать завтра в 9 утра? Нас двое.')).toBeNull();
    expect(toRu('我们明天早上9点可以出发吗？我们一共2个人。', 'Можем ли мы выехать завтра в 9 утра? Нас всего двое.')).toBeNull();
    expect(toRu('We are a group of 4, travelling with 3 kids.', 'Мы едем вчетвером, с нами трое детей.')).toBeNull();
  });

  it('другое число словом — по-прежнему отказ', () => {
    expect(toRu('There are 2 of us.', 'Нас трое.')).toMatch(/нет чисел исходника: 2/);
    expect(toRu('We are a group of 4.', 'Нас пятеро.')).toMatch(/нет чисел исходника: 4/);
  });

  it('с русского: «нас будет двое» → «2 of us» и «2个人»', () => {
    expect(toEn('Нас будет двое, приедем вечером.', 'There will be 2 of us, we arrive in the evening.')).toBeNull();
    expect(toZh('Нас будет двое, приедем вечером.', '我们一共2个人，晚上到。')).toBeNull();
    expect(toEn('Нас будет двое.', 'There will be 3 of us.')).toMatch(/появились числа, которых нет в исходнике: 3/);
  });

  it('слово число только оправдывает: «оба дня» цифры в переводе не требует', () => {
    expect(russianWordNumbersOf('Нас двое, едем вчетвером, оба дня свободны, семеро ждут')).toEqual(new Set(['2', '4', '7']));
    expect(toEn('Оба дня свободны.', 'Both days are free.')).toBeNull();
    // Правило карточек (lib/zh/fields) — то же: слово оправдывает цифру.
    expect(checkSegment('В номере живут двое.', '房间住2人。')).toBeNull();
    expect(checkSegment('В номере живут двое.', '房间住3人。')).toMatch(/появились числа/);
  });
});

describe('время суток — одно в разных записях', () => {
  it('к одному виду: час в 12-часовом счёте, нулевые минуты опущены', () => {
    expect(clockCanon('Сбор в 8:00, возвращение около 19:00, ужин в 19:30.')).toBe('Сбор в 8, возвращение около 7, ужин в 7:30.');
    expect(clockCanon('00:30 и 12:00')).toBe('12:30 и 12');
    expect(clockCanon('19点出发，20時到')).toBe('7点出发，8時到');
    // Не время: длительность, дата, цена, срок (разряды цены склеивает общая запись цифр).
    expect(clockCanon('20 часов в пути, 15.07, 15 000 ₽, 19小时')).toBe('20 часов в пути, 15.07, 15000 ₽, 19小时');
  });

  it('с русского: «19:00» годится как «19:00», «7:00 p.m.» и «晚上7点»', () => {
    const ru = 'Сбор в 8:00 у гостиницы, возвращение около 19:00.';
    expect(toEn(ru, 'We meet at 8:00 at the hotel and return around 19:00.')).toBeNull();
    expect(toEn(ru, 'We meet at 8:00 a.m. at the hotel and return around 7:00 p.m.')).toBeNull();
    expect(toEn(ru, 'We meet at 8 am at the hotel and return around 7 pm.')).toBeNull();
    expect(toZh(ru, '8:00在酒店集合，约19:00返回。')).toBeNull();
    expect(toZh(ru, '早上8点在酒店集合，晚上7点左右返回。')).toBeNull();
    expect(toZh(ru, '8点在酒店集合，19点左右返回。')).toBeNull();
  });

  it('другой час — отказ, в любой записи', () => {
    const ru = 'Сбор в 8:00 у гостиницы, возвращение около 19:00.';
    expect(toEn(ru, 'We meet at 8:00 a.m. at the hotel and return around 8:00 p.m.')).toMatch(/нет чисел исходника: 7/);
    expect(toEn(ru, 'We meet at 9 am at the hotel and return around 7 pm.')).toMatch(/нет чисел исходника: 8/);
    expect(toZh(ru, '早上8点在酒店集合，晚上9点左右返回。')).toMatch(/нет чисел исходника|появились числа/);
    // Минуты не теряются и не выдумываются.
    expect(toEn('Выезд в 8:30.', 'Departure at 8 am.')).toMatch(/нет чисел исходника: 30/);
    expect(toEn('Выезд в 8:00.', 'Departure at 8:15 am.')).toMatch(/появились числа, которых нет в исходнике: 15/);
  });

  it('на русский: «7 pm» годится как «19:00», «7 вечера» и «в 19 часов»', () => {
    expect(toRu('We arrive at 7 pm.', 'Мы приедем в 19:00.')).toBeNull();
    expect(toRu('We arrive at 7 pm.', 'Мы приедем в 7 вечера.')).toBeNull();
    expect(toRu('We arrive at 7 pm.', 'Мы приедем в 19 часов.')).toBeNull();
    expect(toRu('We arrive at 7:30 p.m.', 'Мы приедем в 19:30.')).toBeNull();
    expect(toRu('我们晚上7点到。', 'Мы приедем в 19 часов.')).toBeNull();
    expect(toRu('We arrive at 19:00.', 'Мы приедем в 19 часов.')).toBeNull();
    expect(toRu('We arrive at 7 pm.', 'Мы приедем в 20:00.')).toMatch(/нет чисел исходника: 7/);
  });

  it('«в 19 часов» → «at 19:00» и «at 7 pm» годны; длительность часом суток не становится', () => {
    expect(toEn('Выезд в 19 часов от гостиницы.', 'Departure at 19:00 from the hotel.')).toBeNull();
    expect(toEn('Выезд в 19 часов от гостиницы.', 'Departure at 7 pm from the hotel.')).toBeNull();
    expect(toEn('Выезд в 19 часов от гостиницы.', 'Departure at 19 from the hotel.')).toBeNull();
    // «Дорога 20 часов» — двадцать: «8 hours» её не заменит.
    expect(toEn('Дорога занимает 20 часов.', 'The drive takes 8 hours.')).toMatch(/нет чисел исходника: 20/);
    expect(toEn('Дорога занимает 20 часов.', 'The drive takes 20 hours.')).toBeNull();
    expect(toRu('The drive takes 8 hours.', 'Дорога занимает 20 часов.')).toMatch(/нет чисел исходника: 8/);
    expect(russianHourAlts('Выезд в 19 часов.', 'Departure at 7 pm.')).toEqual(new Map([['19', '7']]));
    expect(russianHourAlts('Дорога 20 часов.', 'The drive takes 8 hours.').size).toBe(0);
  });
});

describe('приведение времени не открывает дорогу выдумке (замечание ревью #3331)', () => {
  it('на русский: минуты, которых нет в исходнике, — отказ', () => {
    expect(toRu('We arrive at 8:00.', 'Мы приедем в 8:45.')).toMatch(/появились числа, которых нет в исходнике: 45/);
    expect(toRu('We arrive at 8 am.', 'Мы приедем в 8:45.')).toMatch(/появились числа, которых нет в исходнике: 45/);
    expect(toRu('我们早上8点到。', 'Мы приедем в 8:15.')).toMatch(/появились числа, которых нет в исходнике: 15/);
    // Те же минуты, что в исходнике, и нулевые — годны.
    expect(toRu('We arrive at 8:45.', 'Мы приедем в 8:45.')).toBeNull();
    expect(toRu('We arrive at 8:45 pm.', 'Мы приедем в 20:45.')).toBeNull();
    expect(toRu('We arrive at 8 am.', 'Мы приедем в 8:00.')).toBeNull();
    expect(toRu('我们8点30分到。', 'Мы приедем в 8:30.')).toBeNull();
  });

  it('длительность без предлога времени часом суток не становится — даже если перевод выдумал «3 pm»', () => {
    expect(toEn('Дорога занимает 15 часов.', 'Departure at 3 pm from the hotel.')).toMatch(/нет чисел исходника: 15/);
    expect(toEn('Перелёт 14 часов.', 'The flight is at 2 pm.')).toMatch(/нет чисел исходника: 14/);
    expect(toRu('Departure at 3 pm.', 'Дорога занимает 15 часов.')).toMatch(/нет чисел исходника: 3/);
    expect(russianHourAlts('Дорога занимает 15 часов.', 'Departure at 3 pm.').size).toBe(0);
    // «До 20 часов» — и срок, и длительность: за «8» сойдёт, только если по ту
    // сторону 8 стоит как время суток.
    expect(toEn('Идём до 20 часов.', 'We walk for up to 8 hours.')).toMatch(/нет чисел исходника: 20/);
    expect(toEn('Идём до 20 часов.', 'We walk until 8 pm.')).toBeNull();
    expect(toEn('Идём до 20 часов.', 'We walk for up to 20 hours.')).toBeNull();
    expect(toRu('We walk for up to 8 hours.', 'Идём до 20 часов.')).toMatch(/нет чисел исходника: 8/);
    expect(russianHourAlts('Идём до 20 часов.', 'We walk for up to 8 hours.').size).toBe(0);
    // С предлогом времени — час суток: «к 19 часам», «около 14 часов».
    expect(toEn('Вернёмся к 19 часам.', 'We will be back by 7 pm.')).toBeNull();
    expect(toEn('Обед около 14 часов.', 'Lunch is at about 2 pm.')).toBeNull();
    expect(toRu('We will be back by 7 pm.', 'Вернёмся к 19 часам.')).toBeNull();
  });
});

describe('«полтора» и «полчаса»', () => {
  it('«1.5 hours» ↔ «полтора часа», «30 minutes» ↔ «полчаса»', () => {
    expect(toRu('The walk takes 1.5 hours.', 'Прогулка занимает полтора часа.')).toBeNull();
    expect(toEn('Дорога занимает полтора часа.', 'The drive takes 1.5 hours.')).toBeNull();
    expect(toEn('Дорога занимает полтора часа.', 'The drive takes an hour and a half.')).toBeNull();
    expect(toRu('We will be there in 30 minutes.', 'Будем через полчаса.')).toBeNull();
    expect(toEn('Будем через полчаса.', 'We will be there in 30 minutes.')).toBeNull();
    expect(russianFractionNumbersOf('около полутора часов')).toEqual(['1', '5']);
    expect(russianFractionNumbersOf('полторашка, полчасика')).toEqual([]);
  });

  it('другое число — отказ', () => {
    expect(toEn('Дорога занимает полтора часа.', 'The drive takes 2.5 hours.')).toMatch(/появились числа, которых нет в исходнике: 2/);
    expect(toRu('The walk takes 2.5 hours.', 'Прогулка занимает полтора часа.')).toMatch(/нет чисел исходника: 2/);
  });
});

describe('прежние отказы на месте', () => {
  it('выдуманный год, потерянная цена, чужая цена', () => {
    expect(toEn('Выезд 15 июля, вернёмся 17 июля.', 'Departure is on 15 July 2027, we return on 17 July.')).toMatch(/появились числа, которых нет в исходнике: 2027/);
    expect(toEn('Цена — 15 000 рублей с человека.', 'The price is per person.')).toMatch(/нет чисел исходника/);
    expect(toEn('Цена — 15 000 рублей с человека.', 'The price is 18,000 rubles per person.')).toMatch(/нет чисел исходника|появились числа/);
    expect(toRu('The budget is 15,000 rubles for 3 days.', 'Бюджет — 18 000 рублей на три дня.')).toMatch(/нет чисел исходника: 15/);
  });

  it('обычные числа проходят как раньше', () => {
    expect(toEn('Цена — 15 000 рублей с человека.', 'The price is 15,000 rubles per person.')).toBeNull();
    expect(toEn('Идём 2–3 часа, подъём 4 км, набор высоты 600 м.', 'We walk for 2–3 hours, the ascent is 4 km with 600 m of elevation gain.')).toBeNull();
    expect(toZh('Цена — 15 000 рублей с человека.', '价格是每人1.5万卢布。')).toBeNull();
    expect(toRu('The budget is 15,000 rubles for 3 days.', 'Бюджет — 15 000 рублей на три дня.')).toBeNull();
  });
});
