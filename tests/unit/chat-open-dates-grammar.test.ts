/**
 * «Открой даты словами» (22.10, этап C): ЯЗЫК фразы — сторож вызовом
 * `parseDatesPhrase` (CLAUDE.md §4, «Сторож судит поведение»).
 *
 * Шестой круг ревью: круги 4, 5, 6 давали по blocker и около шести major —
 * всё в связях между словами (дефис вплотную, связка между группами дат,
 * точка вокруг дней недели, «…» внутри числа, «за 5000» в названии тура).
 * Решение главной сессии: фразу принимает закрытая позиционная грамматика
 * (lib/operators/chat-dates/grammar.ts, язык — в её шапке), как шаблоны
 * #2527 (lib/safety/rescue-protocols.ts). Держится:
 *   - снимок закрытых списков языка: правка любого — видимая;
 *   - каждая форма языка даёт предложение с точными датами — и перечислением
 *     по каждому слову каждого списка;
 *   - все фразы ревьюеров кругов 4–7 — с исходом: ни одного предложения,
 *     отличного от сказанного (таблицы — tests/unit/chat-open-dates-phrases.ts);
 *   - вставка в любое место любой принятой фразы — слова, знака, «слово+знак+
 *     слово», «…» между цифрами, повтора даты — даёт отказ; то же
 *     предложение — только от вежливости языка (вставки после глагола, хвост);
 *   - сверка с прежним разбором (114bd9e4f): фразы языка дают ровно то же,
 *     вышедшие — в таблице цены с причиной.
 *
 * «Сегодня» — 22 октября 2026 по Камчатке.
 */
import { describe, it, expect } from 'vitest';
import { type ChatTour, type DatesParse, CONNECTORS, parseDatesPhrase } from '@/lib/operators/chat-dates/parse';
import { LANGUAGE } from '@/lib/operators/chat-dates/grammar';
import {
  type Outcome, FIXED, PRICE, REVIEW4, REVIEW5, REVIEW5_TRAPS, REVIEW6, REVIEW6_T5, REVIEW6_T7, REVIEW7, REVIEW7_DT, SAME_AS_BEFORE, TOURS,
} from './chat-open-dates-phrases';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const T3 = TOURS.T3;

const label = (p: DatesParse): string =>
  p.kind === 'refused' ? `R:${p.reason}` : p.kind === 'ask' ? `A:${p.what}` : p.kind;
const tourLabel = (p: Extract<DatesParse, { kind: 'proposal' }>): string =>
  p.tour.kind === 'one' ? `one:${p.tour.id}` : p.tour.kind === 'choose' ? `choose:${p.tour.ids.join(',')}` : p.tour.kind;
const datesOf = (days: Record<string, number[]>): string[] =>
  Object.entries(days).flatMap(([m, ds]) => ds.map((d) => `${m}-${String(d).padStart(2, '0')}`));
const parse = (text: string, tours: ChatTour[] = T3): DatesParse => parseDatesPhrase(text, NOW, tours);

function expectOutcome(text: string, tours: ChatTour[], want: Outcome): void {
  const p = parse(text, tours);
  if (typeof want === 'string') {
    expect(label(p), JSON.stringify(p)).toBe(want);
    return;
  }
  expect(p.kind, JSON.stringify(p)).toBe('proposal');
  if (p.kind !== 'proposal') return;
  expect(p.dates).toEqual(datesOf(want.days));
  expect(p.seats).toBe(want.seats);
  expect(tourLabel(p)).toBe(want.tour);
}

describe('язык: закрытые списки — снимок', () => {
  it('правка любого списка — видимая правка этого снимка', () => {
    expect(LANGUAGE).toEqual({
      greetings: ['привет', 'здравствуйте', 'добрый день', 'добрый вечер', 'доброе утро'],
      address: ['кузьмич'],
      verbs: ['открой', 'откройте', 'открыть', 'открывай', 'открывайте', 'добавь', 'добавьте', 'добавить', 'выставь', 'выставьте', 'выставить'],
      fillers: ['мне', 'нам', 'пожалуйста', 'плиз', 'срочно', 'сразу', 'еще', 'тоже', 'также', 'только', 'пока'],
      objectNew: ['новые', 'новую', 'новый'],
      objects: ['даты', 'дату', 'дата', 'выезды', 'выезд', 'места', 'место', 'слоты', 'слот', 'продажи', 'продажу', 'запись', 'набор', 'группу', 'тур'],
      tail: ['спасибо', 'пожалуйста'],
      monthGen: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
      monthAbbr: { янв: 1, фев: 2, февр: 2, мар: 3, апр: 4, авг: 8, сен: 9, сент: 9, окт: 10, ноя: 11, нояб: 11, дек: 12 },
      monthNom: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
      monthPrep: ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'],
      weekdayPlural: ['понедельники', 'вторники', 'среды', 'четверги', 'пятницы', 'субботы', 'воскресенья'],
      weekdayDative: ['понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'],
      weekdayAcc: ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'],
      weekdayGen: ['понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы', 'воскресенья'],
      weekdayAbbr: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'],
      weekdayEvery: { каждый: [0, 1, 3], каждую: [2, 4, 5], каждое: [6] },
      relative: ['сегодня', 'завтра', 'послезавтра'],
      seatUnits: ['мест', 'места', 'место', 'человек', 'чел'],
      priceUnits: ['руб', 'рублей', 'рубля', 'рубль', 'р', 'тыс', 'тысяч', 'тысячи', 'тысяча'],
      tourSlots: ['на', 'тур', 'для'],
    });
  });
});

// ── Каждая форма языка ────────────────────────────────────────────────────

/** Дни недели месяца: 0 = пн … 6 = вс. */
function weekdaysIn(y: number, m: number, days: number[]): string[] {
  const out: string[] = [];
  for (let d = 1; d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); d++) {
    const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (days.includes(js === 0 ? 6 : js - 1)) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}
const JULY = (days: number[]) => weekdaysIn(2027, 7, days);
const ALL_JULY = JULY([0, 1, 2, 3, 4, 5, 6]);
const AUG3 = ['2027-08-03'];
const ONE_TOUR: ChatTour[] = [{ id: '11', title: 'Вулкан Горелый', active: true }];

/** Формы шапки grammar.ts — по фразе на каждую, с точным исходом. */
const FORMS: Array<[string, string[], number | null]> = [
  // Отдельные даты.
  ['открой 3 августа', AUG3, null],
  ['открой 3, 5 и 7 августа, 6 мест', ['2027-08-03', '2027-08-05', '2027-08-07'], 6],
  ['открой 3 и 5 и 7 августа, 6 мест', ['2027-08-03', '2027-08-05', '2027-08-07'], 6],
  ['открой 3, и 5 августа, 6 мест', ['2027-08-03', '2027-08-05'], 6],
  ['открой субботу 3 июля, 8 мест', ['2027-07-03'], 8],
  ['открой 22 октября 2027, 8 мест', ['2027-10-22'], 8],
  ['открой 3 августа 2027 года, 8 мест', AUG3, 8],
  ['открой 3-го августа, 8 мест', AUG3, 8],
  ['открой 03.08 и 5.08, 8 мест', ['2027-08-03', '2027-08-05'], 8],
  ['открой 3.8.2027, 8 мест', AUG3, 8],
  ['открой 03.08.27, 8 мест', AUG3, 8],
  ['открой 2027-08-03 и 2027-08-05, 8 мест', ['2027-08-03', '2027-08-05'], 8],
  // Отрезки.
  ['открой с 1 по 10 июля, 8 мест', ALL_JULY.slice(0, 10), 8],
  ['открой со 2 по 9 авг, 8 мест', weekdaysIn(2027, 8, [0, 1, 2, 3, 4, 5, 6]).slice(1, 9), 8],
  ['открой 3 августа - 9 августа включительно, 8 мест', weekdaysIn(2027, 8, [0, 1, 2, 3, 4, 5, 6]).slice(2, 9), 8],
  ['открой с 1 по 10 июля включительно, 8 мест', ALL_JULY.slice(0, 10), 8],
  ['открой с 30 декабря по 2 января, 5 мест', ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'], 5],
  ['открой с 30 декабря 2026 по 2 января 2027, 5 мест', ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'], 5],
  ['открой 1-10 июля, 8 мест', ALL_JULY.slice(0, 10), 8],
  ['открой 1 - 10 июля включительно, 8 мест', ALL_JULY.slice(0, 10), 8],
  ['открой 30 июля - 2 августа, 8 мест', ['2027-07-30', '2027-07-31', '2027-08-01', '2027-08-02'], 8],
  ['открой с 01.07 по 03.07, 5 мест', ALL_JULY.slice(0, 3), 5],
  ['открой 03.07-05.07, 5 мест', ALL_JULY.slice(2, 5), 5],
  ['открой 03.07-05.07 включительно, 5 мест', ALL_JULY.slice(2, 5), 5],
  // Месяц целиком.
  ['открой весь июль, 8 мест', ALL_JULY, 8],
  ['открой весь июль 2027, 8 мест', ALL_JULY, 8],
  ['открой июль целиком, 8 мест', ALL_JULY, 8],
  ['открой июль полностью, 8 мест', ALL_JULY, 8],
  ['открой каждый день июля, 8 мест', ALL_JULY, 8],
  ['открой все дни июля, 8 мест', ALL_JULY, 8],
  // Дни недели.
  ['открой субботы июля, 8 мест', JULY([5]), 8],
  ['открой субботы июля и августа, 8 мест', [...JULY([5]), ...weekdaysIn(2027, 8, [5])], 8],
  ['открой будни ноября, 8 мест', weekdaysIn(2026, 11, [0, 1, 2, 3, 4]), 8],
  ['открой выходные дни июля, 8 мест', JULY([5, 6]), 8],
  ['открой все выходные июля, 8 мест', JULY([5, 6]), 8],
  ['открой будние дни июля, 8 мест', JULY([0, 1, 2, 3, 4]), 8],
  ['открой каждый будний день июля, 8 мест', JULY([0, 1, 2, 3, 4]), 8],
  ['открой сб и вс июля, 8 мест', JULY([5, 6]), 8],
  ['открой пн-пт июля, 8 мест', JULY([0, 1, 2, 3, 4]), 8],
  ['открой субботы, воскресенья и вторники июля, 8 мест', JULY([1, 5, 6]), 8],
  ['открой каждую субботу и каждое воскресенье июля, 8 мест', JULY([5, 6]), 8],
  ['открой каждые выходные июля, 8 мест', JULY([5, 6]), 8],
  ['открой сб и вс с 1 по 15 июля, 8 мест', JULY([5, 6]).filter((d) => d <= '2027-07-15'), 8],
  ['открой каждый вторник в августе, 6 мест', weekdaysIn(2027, 8, [1]), 6],
  ['открой пт-вс в июле, 8 мест', JULY([4, 5, 6]), 8],
  ['открой субботы с июля по август, 8 мест', [...JULY([5]), ...weekdaysIn(2027, 8, [5])], 8],
  ['открой по субботам в июле и августе, 8 мест', [...JULY([5]), ...weekdaysIn(2027, 8, [5])], 8],
  ['открой в июле по субботам, 8 мест', JULY([5]), 8],
  ['открой весь июль по субботам, 8 мест', JULY([5]), 8],
  ['открой по выходным весь июль, 8 мест', JULY([5, 6]), 8],
  ['открой июль по выходным и вторникам, 8 мест', JULY([1, 5, 6]), 8],
  ['открой по всем субботам июля, 8 мест', JULY([5]), 8],
  ['открой с 1 по 15 июля по субботам, 8 мест', JULY([5]).filter((d) => d <= '2027-07-15'), 8],
  ['открой по субботам с 1 по 15 июля, 8 мест', JULY([5]).filter((d) => d <= '2027-07-15'), 8],
  ['открой с июля по август по субботам, 8 мест', [...JULY([5]), ...weekdaysIn(2027, 8, [5])], 8],
  ['открой по субботам с июля по август, 8 мест', [...JULY([5]), ...weekdaysIn(2027, 8, [5])], 8],
  ['открой с понедельника по пятницу в июле, 8 мест', JULY([0, 1, 2, 3, 4]), 8],
  // «Сегодня», несколько групп.
  ['открой сегодня и завтра, 4 места', ['2026-10-22', '2026-10-23'], 4],
  ['открой послезавтра, 4 места', ['2026-10-24'], 4],
  ['открой субботы июля и 3 августа, 8 мест', [...JULY([5]), ...AUG3], 8],
  ['открой 3 августа и 5 сентября, 8 мест', ['2027-08-03', '2027-09-05'], 8],
  ['открой 1-3 июля, и 15 июля, 8 мест', ['2027-07-01', '2027-07-02', '2027-07-03', '2027-07-15'], 8],
  ['открой на 3 августа, 8 мест', AUG3, 8],
  ['открой на субботы июля 8 мест', JULY([5]), 8],
  // Места.
  ['открой 3 августа на 8 мест', AUG3, 8],
  ['открой 3 августа по 8 мест', AUG3, 8],
  ['открой 3 августа до 8 человек', AUG3, 8],
  ['открой 3 августа, 1 место', AUG3, 1],
  ['открой 3 августа, 8 чел', AUG3, 8],
  ['открой 3 августа, мест: 8', AUG3, 8],
  ['открой 3 и 5 августа по 8 мест на каждую дату', ['2027-08-03', '2027-08-05'], 8],
  ['открой 3 и 5 августа, на 8 мест на каждый выезд', ['2027-08-03', '2027-08-05'], 8],
  ['открой 10 мест 3 августа', AUG3, 10],
  // Цена — пометка, даты те же.
  ['открой 3 августа по 15000 руб, 8 мест', AUG3, 8],
  ['открой 3 августа, 8 мест, 15 000 руб', AUG3, 8],
  ['открой 3 августа по 12 тысяч, 8 мест', AUG3, 8],
  ['открой 3 августа по 15к, 8 мест', AUG3, 8],
  ['открой 3 августа за 5000 ₽, 8 мест', AUG3, 8],
  ['открой 3 августа от 5 тыс, 8 мест', AUG3, 8],
  // Начало и конец фразы.
  ['Кузьмич, открой 3 августа, 8 мест', AUG3, 8],
  ['привет, открой 3 августа, 8 мест', AUG3, 8],
  ['добрый день! открой 3 августа, 8 мест', AUG3, 8],
  ['доброе утро, кузьмич, открой 3 августа, 8 мест', AUG3, 8],
  ['открой-ка мне, пожалуйста, сразу 3 августа, 8 мест', AUG3, 8],
  ['открой ещё 3 августа', AUG3, null],
  ['открой, пожалуйста, 3 августа, 8 мест', AUG3, 8],
  ['открой даты 3 и 5 августа, 8 мест', ['2027-08-03', '2027-08-05'], 8],
  ['открой новые даты: 3 и 5 августа, 8 мест', ['2027-08-03', '2027-08-05'], 8],
  ['открой продажи на 3 августа, 8 мест', AUG3, 8],
  ['открой тур на 3 августа, 8 мест', AUG3, 8],
  ['открой 3 августа, 8 мест, спасибо', AUG3, 8],
  ['открой 3 августа, 8 мест, пожалуйста.', AUG3, 8],
  ['открой 3 августа, 8 мест!', AUG3, 8],
  ['Открой 03.08.', AUG3, null],
];

/** Тур: «на», «тур», «для» — где угодно; без них — первой частью. */
const TOUR_FORMS: Array<[string, ChatTour[], string]> = [
  ['открой 3 августа на Горелый, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['открой 3 августа на Горелого, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['открой 3 августа для Горелого, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['открой 3 августа тур Горелый, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['открой 3 августа на вулкан Горелый, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['Открой Горелый на 3 августа, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['Выставь вулкан Горелый 3 августа, 8 мест', TOURS.OLD_TOURS, 'one:11'],
  ['открой 3 августа на вулкан, 8 мест', TOURS.OLD_TOURS, 'choose:11,12,21'],
  ['открой 3 августа на Авачу, 8 мест', TOURS.OLD_TOURS, 'one:21'],
  ['открой 3 августа на сплав по реке Опала, 8 мест', TOURS.OLD_TOURS, 'one:22'],
  ['открой 3 августа на рыбалку, 8 мест', TOURS.OLD_TOURS, 'one:13'],
  ['открой 3 августа на Мутновский 5 дней, 8 мест', TOURS.TRAPS, 'one:11'],
  ['открой 3 августа на прогулку после обеда, 8 мест', TOURS.TRAPS, 'one:8'],
  ['открой субботы июля на Июльский сплав, 8 мест', TOURS.TRAPS, 'one:6'],
  // Название, начатое словом даты или отношения к ней, — после «тур» (седьмой ревью, M1).
  ['открой 3 августа тур Между двух вулканов, 8 мест', TOURS.TRAPS, 'one:9'],
  ['открой с 1 по 31 июля тур Выходные на Авачинском, 8 мест', TOURS.TRAPS, 'one:4'],
  ['открой 3 августа тур Неделя на Камчатке, 8 мест', TOURS.T5, 'one:6'],
  ['открой тур Выходные на Авачинском весь июль, 8 мест', TOURS.DATE_TITLES, 'one:3'],
  ['открой тур: Субботы на Халактыре 3 августа, 8 мест', TOURS.DATE_TITLES, 'one:4'],
  // Слова названия — не «закрой», «скрой», «занято» (седьмой ревью, m4).
  ['открой 3 августа на Закрытую бухту, 8 мест', TOURS.DATE_TITLES, 'one:8'],
  ['открой 3 августа на Скрытый водопад, 8 мест', TOURS.DATE_TITLES, 'one:9'],
  ['открой 3 августа на Занятия на вулкане, 8 мест', TOURS.DATE_TITLES, 'one:10'],
];

describe('язык: каждая форма — предложение с точными датами', () => {
  it.each(FORMS)('«%s»', (text, dates, seats) => {
    const p = parse(text, ONE_TOUR);
    expect(p.kind, JSON.stringify(p)).toBe('proposal');
    if (p.kind !== 'proposal') return;
    expect(p.dates).toEqual(dates);
    expect(p.seats).toBe(seats);
  });
  it.each(TOUR_FORMS)('«%s» — тур %s', (text, tours, tour) => {
    const p = parse(text, tours);
    expect(p.kind, JSON.stringify(p)).toBe('proposal');
    if (p.kind === 'proposal') expect(tourLabel(p)).toBe(tour);
  });
  it('цена — пометка в предложении, а не дата', () => {
    for (const [text] of FORMS.filter(([t]) => /руб|тыс|15к|₽/.test(t))) {
      const p = parse(text, ONE_TOUR);
      expect(p.kind === 'proposal' && p.priceMentioned, text).toBe(true);
    }
  });
});

describe('язык: каждое слово каждого списка — в предложении (перечисление на снимке)', () => {
  const dates = (text: string): string[] | string => {
    const p = parse(text, ONE_TOUR);
    return p.kind === 'proposal' ? p.dates : label(p);
  };
  const yearOf = (m: number): number => (m >= 10 ? 2026 : 2027);
  const dayStr = (m: number, d: number): string => `${yearOf(m)}-${String(m).padStart(2, '0')}-${d}`;

  it('глаголы, вставки, предметы, приветствия, хвост', () => {
    for (const v of LANGUAGE.verbs) expect(dates(`${v} 3 августа, 8 мест`), v).toEqual(AUG3);
    for (const v of LANGUAGE.verbs) expect(dates(`${v}-ка 3 августа, 8 мест`), v).toEqual(AUG3);
    for (const f of LANGUAGE.fillers) expect(dates(`открой ${f} 3 августа`), f).toEqual(AUG3);
    // «ещё» при местах — добавка или итог, не угадываем (седьмой ревью, m1).
    for (const f of LANGUAGE.fillers) expect(dates(`открой ${f} 3 августа, 8 мест`), f).toEqual(f === 'еще' ? 'R:seats_delta' : AUG3);
    for (const o of LANGUAGE.objects) expect(dates(`открой ${o} 3 августа, 8 мест`), o).toEqual(AUG3);
    for (const n of LANGUAGE.objectNew) expect(dates(`открой ${n} даты 3 августа, 8 мест`), n).toEqual(AUG3);
    for (const g of LANGUAGE.greetings) expect(dates(`${g}, открой 3 августа, 8 мест`), g).toEqual(AUG3);
    for (const t of LANGUAGE.tail) expect(dates(`открой 3 августа, 8 мест, ${t}`), t).toEqual(AUG3);
  });
  it('месяцы: родительный (и сокращения), именительный, предложный', () => {
    LANGUAGE.monthGen.forEach((g, i) => expect(dates(`открой 28 ${g}, 8 мест`), g).toEqual([dayStr(i + 1, 28)]));
    for (const [a, m] of Object.entries(LANGUAGE.monthAbbr)) expect(dates(`открой 28 ${a}, 8 мест`), a).toEqual([dayStr(m, 28)]);
    LANGUAGE.monthNom.forEach((n, i) => {
      const got = dates(`открой весь ${n}, 8 мест`);
      expect(Array.isArray(got) && got[got.length - 1]!.startsWith(`${yearOf(i + 1)}-${String(i + 1).padStart(2, '0')}`), n).toBe(true);
    });
    LANGUAGE.monthPrep.forEach((p, i) => expect(dates(`открой субботы в ${p}, 8 мест`), p)
      .toEqual(weekdaysIn(yearOf(i + 1), i + 1, [5]).filter((d) => d >= '2026-10-22')));
  });
  it('дни недели: каждая форма каждого дня', () => {
    LANGUAGE.weekdayPlural.forEach((w, i) => expect(dates(`открой ${w} июля, 8 мест`), w).toEqual(JULY([i])));
    LANGUAGE.weekdayAbbr.forEach((w, i) => expect(dates(`открой ${w} июля, 8 мест`), w).toEqual(JULY([i])));
    LANGUAGE.weekdayDative.forEach((w, i) => expect(dates(`открой по ${w} в июле, 8 мест`), w).toEqual(JULY([i])));
    // 5 июля 2027 — понедельник: «понедельник 5 июля», «вторник 6 июля» …
    LANGUAGE.weekdayAcc.forEach((w, i) => expect(dates(`открой ${w} ${5 + i} июля, 8 мест`), w).toEqual([`2027-07-${String(5 + i).padStart(2, '0')}`]));
    // «с воскресенья по воскресенье» — одинаковые концы, отказ (седьмой ревью, m3).
    LANGUAGE.weekdayGen.forEach((w, i) => expect(dates(`открой с ${w} по воскресенье в июле, 8 мест`), w)
      .toEqual(i === 6 ? 'R:range_same' : JULY([0, 1, 2, 3, 4, 5, 6].filter((d) => d >= i))));
    for (const [q, days] of Object.entries(LANGUAGE.weekdayEvery)) {
      for (const d of days) expect(dates(`открой ${q} ${LANGUAGE.weekdayAcc[d]} июля, 8 мест`), `${q} ${d}`).toEqual(JULY([d]));
    }
  });
  it('«сегодня», единицы мест и цены, места тура', () => {
    LANGUAGE.relative.forEach((r, i) => expect(dates(`открой ${r}, 8 мест`), r).toEqual([`2026-10-${22 + i}`]));
    for (const u of LANGUAGE.seatUnits) expect(parse(`открой 3 августа, 8 ${u}`, ONE_TOUR), u).toMatchObject({ kind: 'proposal', seats: 8 });
    for (const u of LANGUAGE.priceUnits) {
      expect(parse(`открой 3 августа по 15 ${u}, 8 мест`, ONE_TOUR), u).toMatchObject({ kind: 'proposal', priceMentioned: true, dates: AUG3 });
    }
    for (const s of LANGUAGE.tourSlots) {
      expect(parse(`открой 3 августа ${s} Горелый, 8 мест`, ONE_TOUR), s).toMatchObject({ kind: 'proposal', tour: { kind: 'one', id: '11' } });
    }
  });
});

// ── Фразы ревьюеров ───────────────────────────────────────────────────────

describe('ревью кругов 4–7: исход каждой фразы — точное предложение или отказ', () => {
  it.each(REVIEW4)('четвёртый: «%s»', (text, want) => expectOutcome(text, T3, want));
  it.each(REVIEW5)('пятый: «%s»', (text, want) => expectOutcome(text, T3, want));
  it.each(REVIEW5_TRAPS)('пятый, туры-ловушки: «%s»', (text, want) => expectOutcome(text, TOURS.TRAPS, want));
  it.each(REVIEW6)('шестой: «%s»', (text, want) => expectOutcome(text, T3, want));
  it.each(REVIEW6_T5)('шестой, туры T5: «%s»', (text, want) => expectOutcome(text, TOURS.T5, want));
  it.each(REVIEW6_T7)('шестой, туры T7: «%s»', (text, want) => expectOutcome(text, TOURS.T7, want));
  it.each(REVIEW7)('седьмой: «%s»', (text, want) => expectOutcome(text, T3, want));
  it.each(REVIEW7_DT)('седьмой, туры DATE_TITLES: «%s»', (text, want) => expectOutcome(text, TOURS.DATE_TITLES, want));

  it('находки шестого круга — отказ, а не предложение', () => {
    for (const text of [
      // B1: дефис и тире вплотную.
      'открой весь июль-сб, 8 мест', 'открой весь август-вс, 8 мест', 'открой с 1 по 31 июля-сб, 8 мест', 'открой весь июль—сб, 8 мест',
      // M1: вторая группа через «на».
      'открой продажи 1 августа, на 5 сентября, 8 мест', 'открой продажи 1 августа и на 5 сентября, 8 мест',
      'открой набор 1 августа; на 5 сентября, 8 мест', 'открой продажи 1 августа. На 5 сентября, 8 мест',
      // M2: связка-поправка между группами.
      'открой 3 августа, только 5 августа, 8 мест', 'открой 3 августа, давай 5 августа, 8 мест',
      'открой 3 августа. Давай 5 августа, 8 мест', 'открой 3 августа, пока 5 августа, 8 мест',
      // M3: дата дважды.
      'открой 3 и 5 августа, 5 августа — 6 мест', 'открой 3 и 5 августа, 5 августа, 6 мест',
      // M4: точка, двоеточие, скобки вокруг дней недели.
      'открой весь июль. Субботы тоже, 8 мест', 'открой весь июль: субботы, 8 мест', 'открой весь июль (субботы), 8 мест',
      // M5: «…».
      'открой 10…12, 8 мест', 'открой 3…5 августа, 8 мест', 'открой 3 августа... 5 августа, 8 мест',
      // M6: «за», «от» перед числом без единицы.
      'открой 3 августа за 5000, 8 мест', 'открой 3 августа от 5000, 8 мест',
    ]) {
      expect(parse(text).kind, text).not.toBe('proposal');
      expect(parse(text, TOURS.T5).kind, text).not.toBe('proposal');
    }
  });

  it('находки седьмого круга — отказ с причиной, а не предложение', () => {
    const DT = TOURS.DATE_TITLES;
    const cases: Array<[string, ChatTour[], string]> = [
      // M1: название тура, начатое словом даты, без «тур» — съело бы дни недели фразы.
      ['открой выходные на Авачинском весь июль, 8 мест', DT, 'R:date_word_in_title'],
      ['открой выходные на Авачинском с 1 по 31 июля, 8 мест', DT, 'R:date_word_in_title'],
      ['открой субботы на Халактыре весь июль, 8 мест', DT, 'R:date_word_in_title'],
      ['открой выходные весь июль, 8 мест', DT, 'R:date_word_in_title'],
      ['открой на выходные с 1 по 31 июля, 8 мест', DT, 'R:date_word_in_title'],
      ['открой 3 августа на Выходные на Авачинском, 8 мест', DT, 'R:date_word_in_title'],
      ['открой каждый день на вулкане весь август, 8 мест', DT, 'R:date_word_in_title'],
      ['открой только вулканы весь август, 8 мест', DT, 'R:date_word_in_title'],
      // M2: год даты зависит от порядка дат.
      ['открой 5 ноября и 22 октября, 8 мест', T3, 'R:year_order'],
      ['открой 5 ноября и 1 октября, 8 мест', T3, 'R:year_order'],
      ['открой 01.11 и 22.10, 8 мест', T3, 'R:year_order'],
      ['открой субботы ноября и 22 октября, 8 мест', T3, 'R:year_order'],
      ['открой 1 января и 31 декабря, 8 мест', T3, 'R:year_order'],
      ['открой 1 января 2027 и 31 декабря, 8 мест', T3, 'R:year_order'],
      ['открой весь январь и 25 декабря, 8 мест', T3, 'R:year_order'],
      ['открой 3 августа и субботы июля, 8 мест', T3, 'R:year_order'],
      ['открой субботы января и декабря, 8 мест', T3, 'R:year_order'],
      ['открой с 1 по 3 ноября и 22 октября, 8 мест', T3, 'R:year_order'],
      // m1: «ещё» вставкой при местах в любой части.
      ['открой ещё на 3 августа 2 места', T3, 'R:seats_delta'],
      ['открой ещё, 8 мест, 3 августа', T3, 'R:seats_delta'],
      ['открой ещё 3 августа по 2 места', T3, 'R:seats_delta'],
      ['открой ещё даты 3 и 5 августа, 8 мест', T3, 'R:seats_delta'],
      // m2: «до» в конце отрезка.
      ['открой с 1 до 10 июля, 8 мест', T3, 'R:range_until'],
      ['открой с 1 июля до 1 августа, 8 мест', T3, 'R:range_until'],
      ['открой с 03.07 до 05.07, 8 мест', T3, 'R:range_until'],
      ['открой сб и вс с 1 до 15 июля, 8 мест', T3, 'R:range_until'],
      // m3: отрезок с одинаковыми концами.
      ['открой сб-сб в июле, 8 мест', T3, 'R:range_same'],
      ['открой со среды по среду в июле, 8 мест', T3, 'R:range_same'],
      ['открой субботы с июля по июль, 8 мест', T3, 'R:range_same'],
      ['открой по субботам с октября по октябрь, 8 мест', T3, 'R:range_same'],
      ['открой с 3 по 3 августа, 8 мест', T3, 'R:range_same'],
      ['открой 03.08-03.08, 8 мест', T3, 'R:range_same'],
    ];
    for (const [text, tours, want] of cases) expect(label(parse(text, tours)), text).toBe(want);
    // Год в отказе — оба варианта: по порядку и сам по себе.
    expect(parse('открой 5 ноября и 22 октября, 8 мест'))
      .toEqual({ kind: 'refused', reason: 'year_order', date: '2027-10-22', other: '2026-10-22', seats: 8, month: null });
    expect(parse('открой субботы января и декабря, 8 мест'))
      .toMatchObject({ reason: 'year_order', date: '2027-12-01', other: '2026-12-01', month: { wd: [5] } });
    // Оба правила дают одно — предложение; явный год — принимается.
    for (const text of ['открой 22 октября и 5 ноября, 8 мест', 'открой 31 декабря и 1 января, 8 мест',
      'открой 31 декабря 2026 и 1 января, 8 мест', 'открой 1 января 2027 и 31 декабря 2026, 8 мест', 'открой субботы декабря и января, 8 мест']) {
      expect(parse(text).kind, text).toBe('proposal');
    }
    expect(parse('открой 31 декабря и 1 января, 8 мест')).toMatchObject({ dates: ['2026-12-31', '2027-01-01'] });
    expect(parse('открой 1 января 2027 и 31 декабря 2026, 8 мест')).toMatchObject({ dates: ['2026-12-31', '2027-01-01'] });
    // «тур» перед названием — его тур; голое — отказ, а не дни недели фразы.
    expect(parse('открой тур Выходные на Авачинском весь июль, 8 мест', DT)).toMatchObject({ kind: 'proposal', tour: { kind: 'one', id: '3' } });
    expect(parse('открой тур Выходные весь июль, 8 мест', DT)).toMatchObject({ kind: 'proposal', tour: { kind: 'one', id: '5' } });
  });
});

// ── Вставка ───────────────────────────────────────────────────────────────

/** Принятые фразы с их турами: формы и все предложения из таблиц ревью. */
const ACCEPTED: Array<[string, ChatTour[]]> = [
  ...FORMS.map(([t]) => [t, ONE_TOUR] as [string, ChatTour[]]),
  ...TOUR_FORMS.map(([t, tours]) => [t, tours] as [string, ChatTour[]]),
  ...([[REVIEW4, T3], [REVIEW5, T3], [REVIEW5_TRAPS, TOURS.TRAPS], [REVIEW6, T3], [REVIEW6_T5, TOURS.T5], [REVIEW6_T7, TOURS.T7],
    [REVIEW7, T3], [REVIEW7_DT, TOURS.DATE_TITLES]] as const)
    .flatMap(([table, tours]) => table.filter(([, w]) => typeof w !== 'string').map(([t]) => [t, tours] as [string, ChatTour[]])),
];
/**
 * Слова языка, вставка которых может дать то же самое предложение: вставки
 * после глагола, хвост, «на» перед датами и местами, «весь» перед месяцем.
 * Слово вне языка не даёт предложения никогда.
 */
const NEUTRAL = new Set<string>([...LANGUAGE.fillers, ...LANGUAGE.tail, 'на', 'весь', 'каждый', 'все', ':']);
const same = (a: DatesParse, b: DatesParse): boolean => JSON.stringify(a) === JSON.stringify(b);

function leaksOf(mutate: (words: string[]) => Array<[string, string | null]>): string[] {
  const leaks: string[] = [];
  for (const [text, tours] of ACCEPTED) {
    const original = parse(text, tours);
    for (const [mutated, polite] of mutate(text.split(' '))) {
      const p = parse(mutated, tours);
      if (p.kind !== 'proposal') continue;
      if (polite !== null && NEUTRAL.has(polite) && same(p, original)) continue;
      leaks.push(`«${mutated}» → ${p.dates.length} дат`);
    }
  }
  return leaks;
}
const insertAll = (junk: string) => (ws: string[]): Array<[string, string | null]> =>
  Array.from({ length: ws.length + 1 }, (_, i): [string, string | null] => [[...ws.slice(0, i), junk, ...ws.slice(i)].join(' '), junk]);
const glueAll = (junk: string) => (ws: string[]): Array<[string, string | null]> => ws.flatMap((w, i): Array<[string, string | null]> => [
  [[...ws.slice(0, i), junk + w, ...ws.slice(i + 1)].join(' '), junk],
  [[...ws.slice(0, i), w + junk, ...ws.slice(i + 1)].join(' '), junk],
]);

describe('третьего исхода нет: вставка в любое место принятой фразы — отказ', () => {
  it('принятых фраз достаточно, и все они — предложения', () => {
    expect(ACCEPTED.length).toBeGreaterThan(200);
    for (const [text, tours] of ACCEPTED) expect(parse(text, tours).kind, text).toBe('proposal');
  });

  const WORDS = [
    'зюзя', 'зю', 'без', 'или', 'утром', 'последнюю', 'утро', 'вечер', 'после', 'кроме', 'не', 'нет', 'минус', 'давай', 'тогда',
    'теперь', 'ладно', 'хорошо', 'сейчас', 'ну', 'а', 'уже', 'потом', 'вернее', 'точнее', 'ежедневно', 'каждый', 'весь', 'на',
    // Вставки языка: то же предложение допустимо, иное — нет.
    'только', 'пока', 'тоже', 'еще', 'пожалуйста',
  ];
  it.each(WORDS)('слово «%s» — отдельно в любом месте', (junk) => {
    expect(leaksOf(insertAll(junk))).toEqual([]);
  }, 120_000);

  const SIGNS = ['-', '—', '−', '❌', '🚫', '~~', '≠', '\\', '✗', '+', '*', '#', '(', ')', ':', ';', '/', '?', '.', '!', '…'];
  it.each(SIGNS)('знак «%s» — отдельно и вплотную к любому слову', (sign) => {
    expect(leaksOf((ws) => [
      // Точка или «!» в самом конце — конец фразы: то же предложение.
      ...insertAll(sign)(ws).filter(([m]) => !((sign === '.' || sign === '!') && m.endsWith(` ${sign}`))),
      ...glueAll(sign)(ws).filter(([m]) => !((sign === '.' || sign === '!') && m.endsWith(sign) && !m.endsWith(`${sign}${sign}`) && m.slice(0, -1) === ws.join(' '))),
    ])).toEqual([]);
  }, 120_000);

  it('слово+знак+слово: два соседних слова склеены знаком', () => {
    for (const sign of ['-', '—', '.', ':', '/', '!']) {
      expect(leaksOf((ws) => ws.slice(0, -1).map((w, i): [string, string | null] =>
        [[...ws.slice(0, i), `${w}${sign}${ws[i + 1]}`, ...ws.slice(i + 2)].join(' '), sign])), sign).toEqual([]);
    }
  }, 120_000);

  it('«…» и «...» между цифрами и после числа', () => {
    expect(leaksOf((ws) => ws.flatMap((w, i): Array<[string, string | null]> => (/\d/.test(w)
      ? ['…', '...'].map((e): [string, string | null] => [[...ws.slice(0, i), w.replace(/(\d+)/, `$1${e}`), ...ws.slice(i + 1)].join(' '), null])
      : [])))).toEqual([]);
  }, 120_000);

  it('повтор названной даты — отказ «дважды», а не молча то же предложение', () => {
    const MONTH = /(\d{1,2}) (?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?: \d{4}(?: года)?)?/u;
    let checked = 0;
    let refused = 0;
    for (const [text, tours] of ACCEPTED) {
      const m = text.match(MONTH);
      if (!m || m.index === undefined) continue;
      const at = m.index + m[0].length;
      const before = parse(text, tours);
      for (const join of [', ', ' и ']) {
        const mutated = `${text.slice(0, at)}${join}${m[0]}${text.slice(at)}`;
        const p = parse(mutated, tours);
        // Предложение допустимо, только если дата новая (была отфильтрована днём недели):
        // молча схлопнутый повтор — то же самое предложение — течь.
        if (p.kind === 'proposal' && before.kind === 'proposal') expect(p.dates, mutated).not.toEqual(before.dates);
        if (p.kind === 'refused' && p.reason === 'repeated_date') refused++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(checked * 0.9);
  });
});

// ── Сверка с прежним разбором ─────────────────────────────────────────────

describe('сверка с 114bd9e4f: язык — то же, вышедшее — цена с причиной', () => {
  it.each(SAME_AS_BEFORE)('«%s» (%s) — то же предложение', (text, set, count, first, last, seats, tour) => {
    const p = parse(text, TOURS[set]);
    expect(p.kind, JSON.stringify(p)).toBe('proposal');
    if (p.kind !== 'proposal') return;
    expect([p.dates.length, p.dates[0], p.dates[p.dates.length - 1], p.seats, tourLabel(p)]).toEqual([count, first, last, seats, tour]);
  });
  it.each(FIXED)('«%s» (%s) — прежний разбор ошибался, язык — нет', (text, set, count, first, last, seats, tour) => {
    const p = parse(text, TOURS[set]);
    expect(p.kind === 'proposal' ? [p.dates.length, p.dates[0], p.dates[p.dates.length - 1], p.seats, tourLabel(p)] : label(p))
      .toEqual([count, first, last, seats, tour]);
  });
  it.each(PRICE)('«%s» (%s) — %s: %s', (text, set, want, reason) => {
    expect(reason.length).toBeGreaterThan(20);
    expect(label(parse(text, TOURS[set]))).toBe(want);
  });
});

describe('связки диагноста — закрытый список', () => {
  // Связки решают только причину отказа у фразы вне языка: принимает язык.
  it('снимок: новое служебное слово — видимая правка этого списка', () => {
    expect([...CONNECTORS].sort()).toEqual([
      'а', 'бы', 'в', 'во', 'вот', 'всего', 'выезд', 'выезда', 'выездов', 'выезды', 'выставить', 'выставляй',
      'выставляйте', 'выставь', 'выставьте', 'группу', 'давай', 'давайте', 'дата', 'датам', 'датами', 'даты', 'дату',
      'добавить', 'добавляй', 'добавляйте', 'добавь', 'добавьте', 'еще', 'же',
      'запись', 'здравствуйте', 'и', 'ка', 'кузьмич', 'кузьмича', 'кузьмичу', 'ладно', 'мест', 'места', 'место', 'мне',
      'можно', 'на', 'нам', 'набор', 'надо', 'новые', 'ну', 'нужно', 'открой', 'откройте', 'открывай', 'открывайте',
      'открыть', 'плиз', 'по', 'пожалуйста', 'пока', 'привет', 'продажи', 'продажу', 'сейчас', 'слот', 'слотов', 'слоты',
      'спасибо', 'сразу', 'срочно', 'также', 'там', 'теперь', 'тогда', 'тоже', 'только', 'тур', 'тура', 'туров', 'туру',
      'туры', 'тут', 'уже',
      'хорошо',
    ].sort());
  });
});
