/**
 * «Открой даты словами» (22.10, этап C): что Кузьмич пишет оператору —
 * вызовом функций текстов на размеченных исходах.
 *
 * Держится: каждый исход назван; «Готово» — только когда записано; название
 * тура и причина закрытия (слова оператора) экранированы — MAX шлёт HTML;
 * ни телефонов, ни почт; длинный список сжат и не длиннее 4000 знаков;
 * пометки под превью — только когда правда; длинное режется в списках
 * дат, а не в предупреждении про автоподтверждение и не в вопросе «Открыть?»
 * (ревью 22.10); подсказка года — ближайший будущий, а не «год + 1»;
 * четвёртый ревью: у каждой даты превью — день недели, правило фразы —
 * словами; список дат не режется (не влезает — «разбейте»);
 * гид со своими турами (29.10): каждая ссылка — в его раздел «Свои туры»,
 * ни одной в кабинет оператора (тот его не пустит); скрытый тур, черновик и
 * сезон включает менеджер Ведара — без кнопок «Показать» и «Активен», которых
 * у гида нет.
 */
import { describe, it, expect } from 'vitest';
import type { DateOpenResult } from '@/lib/tours/availability-open';
import { escapeHtml } from '@/lib/text/escape-html';
import {
  type ChatTour, type DatesAsk, type DatesParse, type DatesRefusal, chatDatesIntent, parseDatesPhrase,
} from '@/lib/operators/chat-dates/parse';
import {
  FLOW_TEXT, MAX_MESSAGE_CHARS, datesByWeekday, datesList, outcomeText, proposalFits, proposalText, readStoredOutcome,
  refusalText, repeatText, askText, askSeatsText, chooseTourText, datesSellerOf, historyAsk, historyResult, nextSameDay,
  telegramDatesText, type StoredOutcome,
} from '@/lib/operators/chat-dates/texts';
import { addSlotsReport } from '@/lib/agents/agencies/operator-agency';

const ALL: DateOpenResult[] = [
  { date: '2027-07-03', result: 'opened' },
  { date: '2027-07-24', result: 'opened' },
  { date: '2027-07-05', result: 'reopened', reason: null },
  { date: '2027-07-10', result: 'already_open', slots: 6 },
  { date: '2027-07-17', result: 'refused_closed', reason: 'Шторм <b>' },
  { date: '2027-07-31', result: 'refused_booked', taken: 9 },
  { date: '2027-10-05', result: 'refused_season', seasonStart: '2027-05-01', seasonEnd: '2027-09-30', from: '2027-05-01', to: '2027-09-30' },
  { date: '2026-10-01', result: 'refused_past' },
  { date: '2028-01-01', result: 'refused_horizon', lastDate: '2027-10-22' },
];

/** Сегодня по Камчатке для образцов подсказок: следующий месяц — ноябрь. */
const TODAY = '2026-10-22';

const done = (perDate: DateOpenResult[], written: number, title = 'Вулкан Горелый'): StoredOutcome =>
  ({ kind: 'done', tourTitle: title, seats: 8, written, perDate });

describe('итог нажатия «Открыть»', () => {
  it('каждый исход назван', () => {
    const t = outcomeText(done(ALL, 3), 'operator');
    expect(t).toMatch(/^Готово, «Вулкан Горелый», 8 мест на выезд\./);
    expect(t).toMatch(/Открыты \(2\): 3, 24 июля 2027\./);
    expect(t).toMatch(/Открыты снова \(1\): 5 июля 2027\./);
    expect(t).toMatch(/Уже были открыты, не менял \(1\): 10 июля 2027 — 6 мест\./);
    expect(t).toMatch(/Не открыты — закрыты вами \(1\): 17 июля 2027 \(«Шторм &lt;b&gt;»\) — открыть их снова можно в кабинете/);
    expect(t).toMatch(/Не открыты — уже записано больше, чем 8 мест \(1\): 31 июля 2027 — записано 9 человек\./);
    expect(t).toMatch(/Не открыты — вне сезона тура \(1\): 5 октября 2027 — сезон 1 мая 2027 — 30 сентября 2027; сезон меняется в карточке тура\./);
    expect(t).toMatch(/Не открыты — прошли \(1\): 1 октября 2026\./);
    expect(t).toMatch(/Не открыты — дальше года вперёд \(1\): 1 января 2028 — туристы такие даты не видят\./);
    expect(t).toMatch(/Проверить: https?:\/\/\S+\/hub\/operator\/calendar$/);
  });

  it('ничего не записано — «Ничего не открыто», а не «Готово»', () => {
    const t = outcomeText(done([{ date: '2027-07-31', result: 'refused_booked', taken: 9 }], 0), 'operator');
    expect(t).toMatch(/^Ничего не открыто: «Вулкан Горелый»/);
    expect(t).not.toMatch(/Готово/);
  });

  it('название тура с разметкой экранировано', () => {
    const t = outcomeText(done([{ date: '2027-07-03', result: 'opened' }], 1, 'Тур <b>жирный</b> & «ко»'), 'operator');
    expect(t).toContain('Тур &lt;b&gt;жирный&lt;/b&gt; &amp; «ко»');
    expect(t).not.toContain('<b>');
  });

  it('тур снят или скрыт — отказ словами', () => {
    expect(outcomeText({ kind: 'refused', reason: 'tour_not_found' }, 'operator')).toBe('Тур снят с продажи или больше не ваш — даты не открыты.');
    expect(outcomeText({ kind: 'refused', reason: 'tour_inactive', title: 'Сплав' }, 'operator')).toMatch(/^Тур «Сплав» скрыт.*Ничего не открыто\.$/s);
  });

  it('повтор — время по Камчатке и прежний итог; итог не прочитался — так и сказано', () => {
    const at = new Date('2026-10-22T02:32:00Z'); // 14:32 по Камчатке
    expect(repeatText(at, done(ALL, 3), 'operator')).toMatch(/^Уже сделано в 14:32 \(по Камчатке\), повтор ничего не меняет:\nГотово/);
    expect(repeatText(at, null, 'operator')).toMatch(/^Уже сделано в 14:32 \(по Камчатке\)\. Итог не прочитался/);
  });

  it('итог из базы проверяется по форме', () => {
    expect(readStoredOutcome(done(ALL, 3))).toEqual(done(ALL, 3));
    expect(readStoredOutcome({ kind: 'done', tourTitle: 'X', seats: 8, written: 1, perDate: [{ date: '2027-07-03', result: 'выдумано' }] })).toBeNull();
    expect(readStoredOutcome('строка')).toBeNull();
  });
});

describe('превью', () => {
  const base = {
    tourTitle: 'Вулкан Горелый', seats: 8, dates: ALL.map((r) => r.date).sort(),
    perDate: ALL, facts: { maxParticipants: 6, isPublished: false, days: 8 }, autoConfirm: true,
    priceMentioned: true, weekdayWords: true, seller: 'operator' as const,
  };

  it('пометки — только правда: группа, частые выезды, не опубликован, автоподтверждение, праздники, цена', () => {
    const { text, canOpen } = proposalText(base);
    expect(canOpen).toBe(true);
    expect(text).toMatch(/^Понял так:\nТур: «Вулкан Горелый»\nМест на каждый выезд: 8\nДаты \(9\):\n— /);
    expect(text).toMatch(/Откроются \(3\): 3, 5, 24 июля 2027\./);
    expect(text).toMatch(/Закрыты вами, не открываю \(1\)/);
    expect(text).toMatch(/Не открою — уже записано больше, чем 8 мест/);
    expect(text).toMatch(/В туре группа до 6 человек — туристы увидят не больше 6 мест\./);
    expect(text).toMatch(/Тур идёт 8 дней, а выезды стоят чаще/);
    expect(text).toMatch(/Тур не опубликован/);
    expect(text).toMatch(/включено автоподтверждение/);
    expect(text).toMatch(/Праздничные дни не учитываю/);
    expect(text).toMatch(/Цену из чата не меняю/);
    expect(text).toMatch(/Пока ничего не изменилось\. Открыть\? Предложение действует 30 минут\.$/);

    const plain = proposalText({ ...base, facts: { maxParticipants: 10, isPublished: true, days: 1 }, autoConfirm: false, priceMentioned: false, weekdayWords: false });
    expect(plain.text).not.toMatch(/группа до|выезды стоят чаще|не опубликован|автоподтвержд|Праздничные|Цену/);
  });

  it('превью не прочиталось — «не смог проверить», кнопка остаётся; автоподтверждение не прочиталось — так и сказано', () => {
    const { text, canOpen } = proposalText({ ...base, perDate: null, facts: null, autoConfirm: null });
    expect(canOpen).toBe(true);
    expect(text).toMatch(/Что сейчас с этими датами — не смог проверить, скажу после нажатия\./);
    expect(text).toMatch(/Включено ли у вас автоподтверждение броней — не смог проверить\./);
  });

  it('открывать нечего — без кнопки и честно', () => {
    const { text, canOpen } = proposalText({ ...base, perDate: [{ date: '2027-07-10', result: 'already_open', slots: 6 }] });
    expect(canOpen).toBe(false);
    expect(text).toMatch(/Открывать нечего — ничего не меняю\.$/);
  });

  it('31 дата подряд сжата в диапазон; сообщение не длиннее 4000 знаков; ни телефонов, ни почт', () => {
    const july = Array.from({ length: 31 }, (_, i) => `2027-07-${String(i + 1).padStart(2, '0')}`);
    expect(datesList(july)).toBe('1–31 июля 2027');
    const long = proposalText({ ...base, tourTitle: 'Т'.repeat(5000), dates: july, perDate: july.map((date) => ({ date, result: 'opened' as const })) });
    expect(long.text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    // Бесконечное название не вытесняет вопрос: название в голове — коротко.
    expect(long.text).toMatch(/Тур: «Т{199}…»/);
    expect(long.text).toMatch(/Открыть\? Предложение действует 30 минут\.$/);
    for (const t of [proposalText(base).text, outcomeText(done(ALL, 3), 'operator')]) {
      expect(t).not.toMatch(/\+7\d{10}|\b8\d{10}\b|@\w+\.\w+/);
    }
  });

  it('одни субботы — с днём недели впереди', () => {
    expect(datesList(['2027-07-03', '2027-07-10', '2027-07-17'], true)).toBe('сб 3, 10, 17 июля 2027');
  });
});

describe('отказы и вопросы разбора', () => {
  it('каждый отказ называет причину и говорит, что ничего не открыто', () => {
    const texts = [
      refusalText({ kind: 'refused', reason: 'negated', word: 'не открывай' }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'too_many', count: 62, seats: 8, parts: ['весь июль', 'весь август'] }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'bad_date', text: '29 февраля 2027' }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'two_seat_numbers', values: [8, 6] }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'leftover_number', token: '10:00', yearLike: false }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'past_only', named: ['2026-10-20'], dropped: [], today: TODAY, seats: 6 }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'range_end', from: '3 августа', to: '8' }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'weekday_scope', seats: null }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'relative_mixed', word: 'сегодня' }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'time_like', token: '9.05' }, TODAY, 'operator'),
      refusalText({ kind: 'refused', reason: 'range_reversed', from: '2027-07-10', to: '2027-07-05', seats: 8, startMonthInherited: false }, TODAY, 'operator'),
    ];
    expect(texts[1]).toMatch(/^Это 62 даты — за раз открываю до 31\. Разбейте по месяцу: «открой весь июль, 8 мест», потом «открой весь август, 8 мест»\./);
    expect(texts[2]).toMatch(/^Даты «29 февраля 2027» нет в календаре/);
    expect(texts[3]).toMatch(/^Назвали два числа мест \(8 и 6\)/);
    expect(texts[4]).toMatch(/^Не понял «10:00»/);
    expect(texts[5]).toMatch(/^20 октября 2026 прошло\. Если про 2027 год — напишите «открой 20 октября 2027, 6 мест»/);
    expect(texts[6]).toMatch(/^Не понял «3 августа … 8»: диапазон пишите с месяцем в конце, например «открой с 3 по 15 ноября, 8 мест»/);
    expect(texts[7]).toMatch(/^Не понял, к какому месяцу какие дни недели\. По одной части за раз: «открой субботы ноября», потом «открой воскресенья декабря»/);
    expect(texts[8]).toMatch(/^«сегодня» рядом с другими датами не понял/);
    expect(texts[9]).toMatch(/^Не понял «9\.05» — если это время, оно задаётся в карточке тура/);
    expect(texts[10]).toMatch(/^Конец диапазона раньше начала: 10 июля 2027 … 5 июля 2027\. Начало пишите первым: «открой с 5 по 10 июля, 8 мест»/);
    for (const t of texts) expect(t).toMatch(/Ничего не открыто\./);
  });

  it('вопросы: месяц целиком или дни; праздничного календаря нет', () => {
    expect(askText({ kind: 'ask', what: 'month_scope', month: 7, year: 2027, fromDay: 1, seats: 8 }, TODAY, 'operator'))
      .toMatch(/^Весь июль 2027 \(31 день\) или некоторые дни\? Напишите «открой весь июль, 8 мест» или, например, «открой субботы июля, 8 мест»/);
    // Текущий месяц — сколько осталось, а не весь: 22 октября — 10 дней.
    expect(askText({ kind: 'ask', what: 'month_scope', month: 10, year: 2026, fromDay: 22, seats: null }, TODAY, 'operator'))
      .toMatch(/^Весь октябрь 2026 — с сегодняшнего это 10 дней \(22–31 октября\) — или некоторые дни\? Напишите «открой весь октябрь»/);
    // Год, который разбор сам не выбрал бы, — в подсказке: «октябрь 2027» 22.10.2026.
    expect(askText({ kind: 'ask', what: 'month_scope', month: 10, year: 2027, fromDay: 1, seats: null }, TODAY, 'operator'))
      .toMatch(/Напишите «открой весь октябрь 2027» или, например, «открой субботы октября 2027»/);
    expect(askText({ kind: 'ask', what: 'weekday_month', days: [5, 6], seats: 4 }, TODAY, 'operator')).toBe('Какого месяца? Например: «открой выходные ноября, 4 места».');
    expect(askText({ kind: 'ask', what: 'vague_period', word: 'майские' }, TODAY, 'operator')).toMatch(/праздничного календаря/);
  });

  it('история помощника — сводка из полей, а не сырая фраза', () => {
    expect(historyAsk('Вулкан Горелый', ['2027-07-03', '2027-07-10'], 8, 'operator'))
      .toBe('Оператор попросил в чате открыть 2 даты (3, 10 июля 2027) тура «Вулкан Горелый» по 8 мест.');
    expect(historyAsk(null, ['2027-07-03'], null, 'operator')).toBe('Оператор попросил в чате открыть 1 дату (3 июля 2027).');
  });
});

describe('ревью 22.10: длинное режется в списках, а не в предупреждениях и вопросе', () => {
  const july = Array.from({ length: 31 }, (_, i) => `2027-07-${String(i + 1).padStart(2, '0')}`);
  const view = (perDate: DateOpenResult[]) => ({
    tourTitle: 'Вулкан Горелый', seats: 8, dates: perDate.map((r) => r.date), perDate,
    facts: { maxParticipants: 6, isPublished: true, days: 1 }, autoConfirm: true, priceMentioned: false, weekdayWords: false,
    seller: 'operator' as const,
  });

  it('31 закрытая дата с причиной в 255 знаков (zod допускает) — автоподтверждение, группа и «Открыть?» на месте', () => {
    // 20 закрыто одной причиной, 11 открывается: сценарий ревью.
    const reason = `Шторм & ${'ветер '.repeat(41)}`.slice(0, 255);
    const perDate: DateOpenResult[] = july.map((date, i) => (i < 20
      ? { date, result: 'refused_closed', reason }
      : { date, result: 'opened' }));
    const { text, canOpen } = proposalText(view(perDate));
    expect(canOpen).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(text).toMatch(/У вас включено автоподтверждение: брони на эти даты подтвердятся сразу\./);
    expect(text).toMatch(/В туре группа до 6 человек/);
    expect(text).toMatch(/Пока ничего не изменилось\. Открыть\? Предложение действует 30 минут\.$/);
    // Причина одна на 20 дат — названа один раз и коротко.
    expect(text.match(/Шторм/g)).toHaveLength(1);
    expect(text).toMatch(/Закрыты вами, не открываю \(20\): 1–20 июля 2027 \(«Шторм &amp; ветер[^»]*…»\)/);
    expect(text).not.toContain('ветер '.repeat(20));
  });

  it('31 разная причина в 255 знаков — каждая коротко, вопрос и пометки на месте', () => {
    const perDate: DateOpenResult[] = july.map((date, i) => ({ date, result: 'refused_closed', reason: `${i} ${'причина '.repeat(40)}`.slice(0, 255) }));
    const { text } = proposalText({ ...view(perDate), perDate: [...perDate, { date: '2027-08-01', result: 'opened' }] });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(text).toMatch(/включено автоподтверждение/);
    expect(text).toMatch(/Открыть\? Предложение действует 30 минут\.$/);
  });

  it('тело длиннее сообщения — режутся строки по датам, остаток назван числом, хвост целиком, сущность HTML не разрезана', () => {
    // Сотни строк исхода (разметка тела не ограничена типом) — длина сообщения
    // держится за счёт тела, а не хвоста.
    const many: DateOpenResult[] = Array.from({ length: 400 }, (_, i) => ({
      date: `2027-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      result: 'refused_closed', reason: `&<${i}> ${'x'.repeat(50)}`,
    }));
    const { text } = proposalText(view(many));
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(text).toMatch(/включено автоподтверждение/);
    expect(text).toMatch(/Открывать нечего — ничего не меняю\.$/);
    expect(text).not.toMatch(/&[a-z]*…/);
    const big = outcomeText(done(many, 0), 'operator');
    expect(big.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(big).toMatch(/Проверить: https?:\/\/\S+\/hub\/operator\/calendar$/);
  });

  it('срез тела не оставляет половину сущности HTML («&am…»): при любом месте среза', () => {
    // Строка тела — почти сплошь «&amp;»; сдвиг на знак пять раз проводит
    // место среза через каждую позицию внутри сущности.
    for (let pad = 0; pad < 5; pad++) {
      const many: DateOpenResult[] = Array.from({ length: 400 }, (_, i) => ({
        date: `2027-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        result: 'refused_closed', reason: `${'x'.repeat(pad)}${i}${'&'.repeat(50)}`,
      }));
      const { text } = proposalText(view(many));
      expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      expect(text.replace(/&(?:amp|lt|gt|quot|#39);/g, '')).not.toContain('&');
    }
  });

  it('выбор тура — кнопкой, а не номером: номер текстом местами не становится', () => {
    const t = chooseTourText({ dates: ['2027-08-03'], seats: null, titles: ['Вулкан Горелый', 'Летняя рыбалка'], priceMentioned: false, weekdayWords: false });
    expect(t).toMatch(/Нажмите кнопку с туром под сообщением — число мест спрошу следом\./);
    expect(t).not.toMatch(/номер тура/);
  });
});

describe('ревью 22.10: подсказка года — ближайший будущий', () => {
  it('«3 августа 2025», сказанное 22.10.2026, — подсказка 2027, а не 2026, который тоже прошёл', () => {
    expect(nextSameDay('2025-08-03', '2026-10-22')).toBe('2027-08-03');
    expect(nextSameDay('2026-10-20', '2026-10-22')).toBe('2027-10-20');
    expect(nextSameDay('2025-10-25', '2026-10-22')).toBe('2026-10-25');
    expect(refusalText({ kind: 'refused', reason: 'past_only', named: ['2025-08-03'], dropped: [], today: '2026-10-22', seats: null }, TODAY, 'operator'))
      .toMatch(/^3 августа 2025 прошло\. Если про 2027 год — напишите «открой 3 августа 2027»/);
  });
  it('29 февраля в ближайшие годы нет — подсказки нет, а не несуществующая дата', () => {
    expect(nextSameDay('2024-02-29', '2026-10-22')).toBeNull();
    expect(refusalText({ kind: 'refused', reason: 'past_only', named: ['2024-02-29'], dropped: [], today: '2026-10-22', seats: 8 }, TODAY, 'operator'))
      .toBe('29 февраля 2024 прошло.\nНичего не открыто.');
  });
});

describe('второй ревью 22.10: подсказка — фраза целиком, которую разбор понимает', () => {
  // «Напишите «весь июль»» вёл в тупик: без глагола ответ по подсказке разбор
  // не узнавал, сообщение уходило помощнику-модели, места из первой фразы
  // терялись. Здесь каждый вопрос и отказ разбора получается ВЫЗОВОМ разбора
  // из фразы оператора, а каждая подсказка в кавычках «…» — снова вызовом:
  // она обязана стать предложением с теми же местами. В кавычках может стоять
  // и слово самого оператора («майские», «10:00») — оно не подсказка.
  type Kind = DatesRefusal['reason'] | DatesAsk['what'];
  const GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
  interface Ctx { today: string; y: number; m: number; d: number }
  const ahead = (c: Ctx, k: number) => (c.m - 1 + k) % 12;
  /** Фразы оператора, которые разбор превращает в каждый вопрос и отказ. Record — новый исход без фразы не соберётся. */
  const PRODUCERS: Record<Kind, Array<(c: Ctx) => string>> = {
    month_scope: [(c) => `открой ${NOM[ahead(c, 2)]}, 8 мест`, (c) => `открой ${NOM[c.m - 1]}`],
    weekday_month: [() => 'открой все субботы, 8 мест', () => 'открой выходные'],
    half_range: [(c) => `открой с 3 ${GEN[ahead(c, 2)]}, 8 мест`, (c) => `открой субботы до 14 ${GEN[ahead(c, 2)]}`],
    vague_period: [() => 'открой майские, 8 мест'],
    negated: [(c) => `не открывай 3 ${GEN[ahead(c, 2)]}`],
    exclusion: [(c) => `открой субботы ${GEN[ahead(c, 2)]} кроме 17-го, 8 мест`],
    mixed_actions: [(c) => `открой 3 ${GEN[ahead(c, 2)]}, а 5 закрой`],
    question: [(c) => `можешь открыть 3 ${GEN[ahead(c, 2)]}?`],
    past_only: [(c) => {
      const y = new Date(Date.parse(`${c.today}T00:00:00Z`) - 86_400_000);
      return `открой ${y.getUTCDate()} ${GEN[y.getUTCMonth()]} ${y.getUTCFullYear()}, 6 мест`;
    }],
    too_many: [
      (c) => `открой весь ${NOM[ahead(c, 2)]} и ${NOM[ahead(c, 3)]}, 8 мест`,
      (c) => `открой весь ${NOM[ahead(c, 2)]} и ${NOM[ahead(c, 3)]}`,
      (c) => `открой с 15 ${GEN[ahead(c, 2)]} по 20 ${GEN[ahead(c, 3)]}, 4 места`,
      (c) => `открой будни с 1 ${GEN[ahead(c, 1)]} по 28 ${GEN[ahead(c, 3)]}, 4 места`,
    ],
    bad_date: [() => 'открой 31 февраля, 8 мест'],
    too_far: [(c) => `открой 3 ${GEN[ahead(c, 2)]} ${c.y + 2}, 8 мест`],
    two_seat_numbers: [(c) => `открой 3 ${GEN[ahead(c, 2)]}, 8 мест или 6 мест`],
    bad_seats: [(c) => `открой 3 ${GEN[ahead(c, 2)]}, 1500 мест`],
    leftover_number: [(c) => `открой 3 ${GEN[ahead(c, 2)]} и 5, 8 мест`, (c) => `открой 3 ${GEN[ahead(c, 2)]}, ${c.y + 1}, 8 мест`],
    weekday_mismatch: [(c) => {
      // День месяца через два от текущего, который не суббота: «субботу 4 января» — противоречие.
      const m = ahead(c, 2);
      const y = m + 1 >= c.m ? c.y : c.y + 1;
      const d = new Date(Date.UTC(y, m, 3)).getUTCDay() === 6 ? 4 : 3;
      return `открой субботу ${d} ${GEN[m]}, 8 мест`;
    }],
    range_end: [(c) => `открой 3 ${GEN[ahead(c, 2)]} по 8`],
    range_reversed: [
      (c) => `открой с 10 по 5 ${GEN[ahead(c, 2)]}, 8 мест`,
      // Месяц начала взят у конца: подсказка «с 25 <прошлого> по 5 <этого>», а не 5–25.
      (c) => `открой с 25 по 5 ${GEN[ahead(c, 2)]}, 8 мест`,
      (c) => `открой с 28 по 3 ${GEN[ahead(c, 1)]}`,
      (c) => `открой 10-1 ${GEN[ahead(c, 2)]}`,
      (c) => {
        // С явными годами и через месяц: начало через 70 дней, конец через 40.
        const at = (n: number) => new Date(Date.parse(`${c.today}T00:00:00Z`) + n * 86_400_000);
        const [a, b] = [at(70), at(40)];
        return `открой с ${a.getUTCDate()} ${GEN[a.getUTCMonth()]} ${a.getUTCFullYear()} по ${b.getUTCDate()} ${GEN[b.getUTCMonth()]} ${b.getUTCFullYear()}, 3 места`;
      },
    ],
    weekday_scope: [(c) => `открой субботы ${GEN[ahead(c, 1)]} и воскресенья ${GEN[ahead(c, 2)]}, 8 мест`],
    relative_mixed: [(c) => `сегодня открой субботы ${GEN[ahead(c, 2)]}, 8 мест`],
    time_like: [(c) => `открой 3 ${GEN[ahead(c, 2)]}, сбор в 9.05, 8 мест`],
    periodicity: [
      (c) => `открой весь ${NOM[ahead(c, 2)]} раз в неделю, 8 мест`,
      (c) => `открой с 1 по 20 ${GEN[ahead(c, 2)]} через день`,
      // Текущий месяц: в его последнюю неделю образец — следующий, иначе «субботы» прошли бы.
      (c) => `открой весь ${NOM[c.m - 1]} по чётным, 5 мест`,
    ],
    not_understood: [() => 'открой 3/08, 8 мест', () => 'открой 8 мест'],
    // Четвёртый ревью 22.10: каждое слово на своём месте.
    unknown_words: [(c) => `открой 3 ${GEN[ahead(c, 2)]} утром, 8 мест`, (c) => `открой субботы ${GEN[ahead(c, 2)]} на сплав`],
    two_tours: [(c) => `открой 3 ${GEN[ahead(c, 2)]} на Горелый и 10 ${GEN[ahead(c, 2)]} на Авачинский, 8 мест`],
    weekday_exclusion: [
      (c) => `открой весь ${NOM[ahead(c, 2)]} без выходных, 8 мест`,
      (c) => `открой будни ${GEN[ahead(c, 2)]} без понедельников`,
      (c) => `открой с 1 по 20 ${GEN[ahead(c, 2)]}, в понедельник выходной, 4 места`,
      (c) => `открой все дни ${GEN[ahead(c, 2)]}, вс выходной, 6 мест`,
      () => 'открой без суббот, 8 мест',
    ],
    alternative: [(c) => `открой сб или вс ${GEN[ahead(c, 2)]}, 8 мест`, (c) => `открой 3 или 5 ${GEN[c.m - 1]}`],
    ordinal: [(c) => `открой первую субботу ${GEN[ahead(c, 2)]}, 8 мест`, (c) => `открой в последнюю субботу ${GEN[c.m - 1]}`],
    number_word: [(c) => `открой две субботы ${GEN[ahead(c, 2)]}, 8 мест`],
    year_words: [(c) => `открой 3 ${GEN[ahead(c, 2)]} следующего года, 8 мест`, (c) => `открой 5 ${GEN[ahead(c, 2)]} 27 года`],
    etc: [(c) => `открой 3, 10 ${GEN[ahead(c, 2)]} и так далее, 8 мест`, (c) => `открой 3 ${GEN[ahead(c, 2)]} и т.д.`],
    seats_delta: [(c) => `открой 3 ${GEN[ahead(c, 2)]}, ещё 2 места`, (c) => `открой 3 ${GEN[ahead(c, 2)]} +2 места`],
    // Пятый ревью 22.10.
    bad_char: [
      (c) => `открой весь ${NOM[ahead(c, 2)]} 🚫 выходные, 8 мест`,
      (c) => `открой 3 и 7 ${GEN[ahead(c, 2)]}, -5 ${GEN[ahead(c, 2)]}, 8 мест`,
      (c) => `открой 3, 5❌ и 7 ${GEN[ahead(c, 2)]}`,
    ],
    unjoined_dates: [
      (c) => `открой продажи 1 ${GEN[ahead(c, 2)]} на 5 ${GEN[ahead(c, 3)]}, 8 мест`,
      (c) => `открой 3 ${GEN[ahead(c, 2)]} на 8 мест, 5 ${GEN[ahead(c, 3)]} на Горелый`,
    ],
    date_relation: [
      (c) => `открой даты после 3 ${GEN[ahead(c, 2)]}, 8 мест`,
      (c) => `открой 5 ${GEN[ahead(c, 2)]} на неделю`,
      (c) => `открой весь ${NOM[c.m - 1]}, каждый день, 4 места`,
    ],
    date_word_in_title: [
      (c) => `открой Выходные на Авачинском на ${NOM[ahead(c, 2)]}, 8 мест`,
      // Восьмой ревью: слово дня недели не первым в названии; образец — даты самой фразы.
      (c) => `открой весь ${NOM[ahead(c, 2)]} на Горелый по субботам, 8 мест`,
      (c) => `открой выходные на Авачинском 3 ${GEN[ahead(c, 2)]}`,
    ],
    seats_total: [(c) => `открой 3 и 5 ${GEN[ahead(c, 2)]}, всего 8 мест`],
    // Шестой ревью 22.10: фраза вне языка; дата дважды.
    off_pattern: [
      (c) => `открой 5 ${GEN[ahead(c, 2)]} Горелый, 8 мест`,
      (c) => `открой 3 ${GEN[ahead(c, 2)]}, только 5 ${GEN[ahead(c, 2)]}, 8 мест`,
      (c) => `открой весь ${NOM[ahead(c, 2)]}. Субботы тоже, 8 мест`,
    ],
    repeated_date: [(c) => `открой 3 и 5 ${GEN[ahead(c, 2)]}, 5 ${GEN[ahead(c, 2)]}, 6 мест`],
    // Седьмой ревью 22.10: год по порядку дат и сам по себе разный; «до» в конце отрезка; одинаковые концы.
    year_order: [
      (c) => `открой 5 ${GEN[ahead(c, 2)]} и 3 ${GEN[ahead(c, 1)]}, 8 мест`,
      (c) => `открой 3 ${GEN[ahead(c, 2)]} и субботы ${GEN[ahead(c, 1)]}, 8 мест`,
      (c) => `открой 5 ${GEN[ahead(c, 2)]} и с 3 по 9 ${GEN[ahead(c, 1)]}, 4 места`,
    ],
    range_until: [
      (c) => `открой с 3 до 9 ${GEN[ahead(c, 2)]}, 8 мест`,
      (c) => `открой сб и вс с 1 до 20 ${GEN[ahead(c, 2)]}`,
      (c) => `открой с 3 до 4 ${GEN[ahead(c, 2)]}, 4 места`,
    ],
    range_same: [(c) => `открой сб-сб в ${PREP[ahead(c, 2)]}, 8 мест`, (c) => `открой с 3 по 3 ${GEN[ahead(c, 2)]}`],
    // Восьмой ревью 22.10: слово исключения в названии тура без «тур».
    action_word_in_title: [(c) => `открой 3 ${GEN[ahead(c, 2)]} на Занятия на вулкане, 8 мест`, (c) => `открой субботы ${GEN[ahead(c, 2)]} на Минус тридцать`],
  };
  /** Туры фразы, если исходу нужен не один «Горелый»: «два тура» — два тура. */
  const TOURS_FOR: Partial<Record<Kind, ChatTour[]>> = {
    two_tours: [{ id: '11', title: 'Вулкан Горелый', active: true }, { id: '12', title: 'Авачинский вулкан', active: true }],
    date_word_in_title: [
      { id: '11', title: 'Вулкан Горелый', active: true }, { id: '14', title: 'Выходные на Авачинском', active: true },
      { id: '17', title: 'Горелый по субботам', active: true },
    ],
    action_word_in_title: [{ id: '15', title: 'Занятия на вулкане', active: true }, { id: '16', title: 'Минус тридцать', active: true }],
  };
  /** Исходы без подсказки: им называть нечего, и это тоже держится. */
  const NO_HINT = new Set<Kind>(['bad_date', 'too_far', 'two_seat_numbers', 'bad_seats', 'weekday_mismatch']);
  const ONE_TOUR = [{ id: '11', title: 'Вулкан Горелый', active: true }];

  // «Сегодня» — по три дня в каждом месяце года, включая 31 декабря: образец
  // подсказки не должен «пройти» в августе и уйти за горизонт в декабре.
  const days: string[] = [];
  for (let i = 0; i < 13; i++) {
    const y = 2026 + Math.floor((9 + i) / 12);
    const m = ((9 + i) % 12) + 1;
    for (const d of [1, 15, 28]) days.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  days.push('2026-12-31');

  const kindOf = (p: DatesParse): Kind | null => (p.kind === 'refused' ? p.reason : p.kind === 'ask' ? p.what : null);
  const quotes = (text: string): string[] => [...text.matchAll(/«([^«»]+)»/g)].map((m) => m[1]!);
  /** Слова оператора, которые текст повторяет в кавычках: дата, число, слово фразы. */
  const echoes = (p: DatesParse): Set<string> => {
    const vals = Object.values(p).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string');
    if (p.kind === 'refused' && p.reason === 'range_end') vals.push(`${p.from} … ${p.to}`);
    return new Set(vals.map(escapeHtml));
  };

  for (const kind of Object.keys(PRODUCERS) as Kind[]) {
    it(`«${kind}»: каждая подсказка — фраза, которую разбор понимает, с теми же местами`, () => {
      for (const today of days) {
        const nowMs = Date.parse(`${today}T00:00:00Z`);
        const c: Ctx = { today, y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)), d: Number(today.slice(8, 10)) };
        const tours = TOURS_FOR[kind] ?? ONE_TOUR;
        for (const make of PRODUCERS[kind]) {
          const phrase = make(c);
          const parsed = parseDatesPhrase(phrase, nowMs, tours);
          expect(kindOf(parsed), `${today}: «${phrase}» → ${JSON.stringify(parsed)}`).toBe(kind);
          const text = parsed.kind === 'ask' ? askText(parsed, today, 'operator') : refusalText(parsed as DatesRefusal, today, 'operator');
          const echo = echoes(parsed);
          const hints = quotes(text).filter((q) => !echo.has(q));
          if (NO_HINT.has(kind)) { expect(hints, text).toEqual([]); continue; }
          expect(hints.length, `${today}: подсказки нет — «${text}»`).toBeGreaterThan(0);
          const seats = 'seats' in parsed ? parsed.seats : undefined;
          for (const hint of hints) {
            const plain = hint.replace(/&amp;/g, '&');
            expect(chatDatesIntent(plain, nowMs), `${today}: «${plain}» из «${text}»`).toBe('dates');
            const again = parseDatesPhrase(plain, nowMs, tours);
            expect(again.kind, `${today}: «${plain}» → ${JSON.stringify(again)}`).toBe('proposal');
            if (typeof seats === 'number' && again.kind === 'proposal') expect(again.seats, `${today}: «${plain}»`).toBe(seats);
          }
        }
      }
    });
  }

  it('прошедшая дата в превью — подсказка тоже фраза целиком, с местами', () => {
    const { text } = proposalText({
      tourTitle: 'Вулкан Горелый', seats: 8, dates: ['2026-10-25'], perDate: null, facts: null, autoConfirm: false,
      priceMentioned: false, weekdayWords: false, pastNamed: ['2026-10-20'], today: TODAY, seller: 'operator',
    });
    expect(text).toContain('20 октября 2026 прошло — не открываю. Если про 2027 год — сначала закончите с этим предложением '
      + '(«Открыть» или «Не надо»): новая фраза его заменит. Потом напишите «открой 20 октября 2027, 8 мест».');
    expect(proposalOf('открой 20 октября 2027, 8 мест').seats).toBe(8);
  });
});

function proposalOf(text: string) {
  const p = parseDatesPhrase(text, Date.parse(`${TODAY}T00:00:00Z`), [{ id: '11', title: 'Вулкан Горелый', active: true }]);
  if (p.kind !== 'proposal') throw new Error(`ждали предложение: ${JSON.stringify(p)}`);
  return p;
}

describe('третий ревью 22.10', () => {
  it('скрытый тур наравне с живым — вопрос называет скрытый, кнопки у него нет', () => {
    const t = chooseTourText({
      dates: ['2027-07-03'], seats: 8, titles: ['Вулкан Горелый (зимний)'], priceMentioned: false, weekdayWords: false,
      hidden: ['Вулкан Горелый (летний) <b>'],
    });
    expect(t).toContain('1. Вулкан Горелый (зимний)');
    expect(t).toContain('«Вулкан Горелый (летний) &lt;b&gt;» скрыт — даты ему из чата не открываются, кнопки у него нет.');
    expect(t).not.toMatch(/^2\./m);
  });
  it('фраза назвала только скрытые туры — один или несколько, «Ничего не открыто»', () => {
    expect(FLOW_TEXT.hiddenTours(['Летний Горелый'], 'operator')).toBe(FLOW_TEXT.hidden('Летний Горелый', 'operator'));
    const many = FLOW_TEXT.hiddenTours(['Летний Горелый', 'Зимний <i>Горелый</i>'], 'operator');
    expect(many).toMatch(/^Туры «Летний Горелый», «Зимний &lt;i&gt;Горелый&lt;\/i&gt;» скрыты/);
    expect(many).toMatch(/Ничего не открыто\.$/);
  });
  it('периодичность: образец — месяц оператора; в его последнюю неделю — следующий', () => {
    const r = (month: number | null, seats: number | null) =>
      refusalText({ kind: 'refused', reason: 'periodicity', word: 'раз в неделю', month, seats }, TODAY, 'operator');
    expect(r(7, 8)).toBe('Периодичность («раз в неделю») не разбираю — открыл бы каждый день подряд. '
      + 'Назовите дни недели, например «открой субботы июля, 8 мест», или перечислите даты числами. Ничего не открыто.');
    expect(r(null, null)).toContain('«открой субботы ноября»');
    expect(refusalText({ kind: 'refused', reason: 'periodicity', word: 'через день', month: 10, seats: 4 }, '2026-10-28', 'operator'))
      .toContain('«открой субботы ноября, 4 места»');
  });
  it('длинный список, который не назвать словами, — без образца на чужие месяцы', () => {
    const t = refusalText({ kind: 'refused', reason: 'too_many', count: 44, seats: 8, parts: [] }, TODAY, 'operator');
    expect(t).toBe('Это 44 даты — за раз открываю до 31. Разбейте по месяцам — одна фраза на месяц. '
      + 'Или в кабинете: ' + t.slice(t.indexOf('http'), t.indexOf('/hub/operator/calendar')) + '/hub/operator/calendar. Ничего не открыто.');
    expect(t).not.toMatch(/весь/);
  });
  it('«с 25 по 5 августа»: месяц начала взят у конца — подсказка «с 25 июля», а не 5–25 августа', () => {
    const t = refusalText({ kind: 'refused', reason: 'range_reversed', from: '2027-08-25', to: '2027-08-05', seats: 8, startMonthInherited: true }, TODAY, 'operator');
    expect(t).toBe('Конец диапазона раньше начала: 25 … 5 августа 2027. Если с 25 июля 2027 — напишите '
      + '«открой с 25 июля по 5 августа, 8 мест». Иначе назовите месяц у обеих дат. Ничего не открыто.');
    expect(t).not.toContain('с 5 по 25');
    // Тот же день месяцем раньше не существует — без подсказки.
    expect(refusalText({ kind: 'refused', reason: 'range_reversed', from: '2027-03-31', to: '2027-03-05', seats: null, startMonthInherited: true }, TODAY, 'operator'))
      .toBe('Конец диапазона раньше начала: 31 … 5 марта 2027. Назовите месяц у обеих дат. Ничего не открыто.');
  });
  it('помощник кабинета: числа склоняются — «2 места», «3 человека»', () => {
    const text = addSlotsReport({
      ok: true, tour: { title: 'Горелый', maxParticipants: 10, isPublished: true, isActive: true }, written: 0,
      perDate: [
        { date: '2027-08-05', result: 'already_open', slots: 2 },
        { date: '2027-08-07', result: 'refused_booked', taken: 3 },
      ],
    }, 2);
    expect(text).toMatch(/Тур «Горелый», 2 места на дату\./);
    expect(text).toMatch(/5 августа 2027 — 2 места/);
    expect(text).toMatch(/уже записано больше, чем 2 места \(1\): 7 августа 2027 — записано 3 человека/);
    // Граница слова — через \p{L}: «\b» в JavaScript кириллицу не знает.
    expect(text).not.toMatch(/(?<!\d)2 мест(?!\p{L})|записано 3(?!\s*\p{L})/u);
  });
});

describe('четвёртый ревью 22.10: превью показывает дни недели и правило', () => {
  const NOW = Date.parse('2026-10-22T00:00:00Z');
  const ONE: ChatTour[] = [{ id: '11', title: 'Вулкан Горелый', active: true }];
  const view = (text: string) => {
    const p = parseDatesPhrase(text, NOW, ONE);
    if (p.kind !== 'proposal') throw new Error(`ждали предложение: ${JSON.stringify(p)}`);
    return proposalText({
      tourTitle: 'Вулкан Горелый', seats: p.seats ?? 8, dates: p.dates, perDate: null, facts: null, autoConfirm: false,
      priceMentioned: p.priceMentioned, weekdayWords: p.weekdayWords, rule: p.rule, today: TODAY, seller: 'operator',
    }).text;
  };
  /** Дни месяца в строке «Даты»: число, перед которым стоит день недели. */
  const weekdayDays = (text: string): string[] => [...text.matchAll(/(пн|вт|ср|чт|пт|сб|вс) (\d+(?:, \d+)*)/g)]
    .flatMap((m) => m[2]!.split(', ').map((d) => `${m[1]} ${d}`));

  it('правило — будни: строка правила, даты группами по дням недели, ни одной субботы и воскресенья', () => {
    const t = view('открой будни июля, 8 мест');
    expect(t).toContain('Правило: будни июля 2027\nДаты (22): пн 5, 12, 19, 26; вт 6, 13, 20, 27; ср 7, 14, 21, 28; чт 1, 8, 15, 22, 29; пт 2, 9, 16, 23, 30 июля 2027');
    expect(weekdayDays(t)).toHaveLength(22);
    expect(t).not.toMatch(/(?:сб|вс) \d/);
  });
  it('у каждой даты — день недели: перечень и отрезок по порядку дат, правило — группами', () => {
    expect(datesByWeekday(['2027-08-03', '2027-08-05', '2027-08-07'])).toEqual(['вт 3, чт 5, сб 7 августа 2027']);
    expect(datesByWeekday(['2027-08-09', '2027-08-10', '2027-08-11'])).toEqual(['пн 9, вт 10, ср 11 августа 2027']);
    expect(datesByWeekday(['2027-07-03', '2027-07-04', '2027-07-10', '2027-07-11'])).toEqual(['сб 3, 10; вс 4, 11 июля 2027']);
    expect(datesList(['2027-07-03', '2027-07-10'], true)).toBe('сб 3, 10 июля 2027');
    const t = view('открой с 28 декабря по 3 января, 5 мест');
    expect(t).toContain('Правило: с 28 декабря 2026 по 3 января 2027\nДаты (7):\n— пн 28, вт 29, ср 30, чт 31 декабря 2026\n— пт 1, сб 2, вс 3 января 2027');
  });
  it('перечень дат — без строки правила; правило и отдельная дата — «отдельно»', () => {
    expect(view('открой 3, 5 и 7 августа, 6 мест')).not.toContain('Правило');
    expect(view('открой субботы июля и 3 августа, 8 мест')).toContain('Правило: субботы июля 2027; отдельно: 3 августа 2027');
    expect(view('открой субботы с июля по сентябрь, 8 мест')).toContain('Правило: субботы июля, августа и сентября 2027');
    expect(view('открой весь октябрь, 4 места')).toContain('Правило: весь октябрь 2026');
  });
  it('выбор тура и вопрос о местах тоже показывают правило и дни недели', () => {
    const c = chooseTourText({ dates: ['2027-07-03', '2027-07-10'], seats: null, titles: ['А', 'Б'], priceMentioned: false, weekdayWords: false, rule: 'субботы июля 2027' });
    expect(c).toMatch(/^На какой тур открыть 2 даты\?\nПравило: субботы июля 2027\nДаты \(2\): сб 3, 10 июля 2027/);
    const a = askSeatsText({ tourTitle: 'Горелый', dates: ['2027-07-03'], priceMentioned: false, weekdayWords: false, rule: null });
    expect(a).toMatch(/^Тур: «Горелый»\nДаты \(1\): сб 3 июля 2027\nСколько мест/);
  });
  it('список дат не режется: 31 дата влезает целиком, сотни — нет, и это отказ «разбейте», а не обрезка', () => {
    const july = Array.from({ length: 31 }, (_, i) => `2027-07-${String(i + 1).padStart(2, '0')}`);
    expect(proposalFits(july, 'весь июль 2027')).toBe(true);
    const many = Array.from({ length: 1500 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10));
    expect(proposalFits(many, null)).toBe(false);
    expect(FLOW_TEXT.tooLong(400)).toBe('Это 400 дат — список не помещается в одно сообщение. Разбейте по месяцам — одна фраза на месяц. Ничего не открыто.');
  });
  it('нажатие снятого предложения: «снято вашим следующим сообщением» — и для замены, и для поправки', () => {
    expect(FLOW_TEXT.superseded).toBe('Это предложение снято вашим следующим сообщением — по нему ничего не открыто. '
      + 'Нажмите кнопку под последним предложением, если оно есть, или напишите фразу ещё раз.');
  });
});

describe('четвёртый ревью 22.10: отказы с подсказкой', () => {
  it('непонятые слова названы, тур — словами названия, подсказка с местами оператора', () => {
    expect(refusalText({ kind: 'refused', reason: 'unknown_words', words: ['утром', '<b>'], tourLike: false, seats: 8 }, TODAY, 'operator'))
      .toBe('Не понял: «утром», «&lt;b&gt;». Напишите фразу целиком, например «открой 3, 5 и 7 ноября, 8 мест» или '
        + '«открой субботы ноября, 8 мест». Ничего не открыто.');
    expect(refusalText({ kind: 'refused', reason: 'unknown_words', words: ['сплав'], tourLike: true, seats: null }, TODAY, 'operator'))
      .toContain('Не понял: «сплав». Тур называйте словами из его названия.');
  });
  it('исключение дня недели — подсказка называет оставшиеся дни и область оператора', () => {
    expect(refusalText({ kind: 'refused', reason: 'weekday_exclusion', word: 'без выходных', keep: [0, 1, 2, 3, 4], scope: 'июля', seats: 8 }, TODAY, 'operator'))
      .toBe('Исключения дней недели («без выходных») не разбираю — назовите дни, которые открыть: «открой будни июля, 8 мест». Ничего не открыто.');
  });
});

describe('седьмой и восьмой ревью 22.10: год по порядку, «до» в конце отрезка, одинаковые концы, тур со словом даты', () => {
  const nowMs = Date.parse(`${TODAY}T00:00:00Z`);
  const text = (phrase: string, tours: ChatTour[] | null = null): string => {
    const p = parseDatesPhrase(phrase, nowMs, tours);
    if (p.kind !== 'refused') throw new Error(`ждали отказ, получили ${JSON.stringify(p)}`);
    return refusalText(p, TODAY, 'operator');
  };
  it('год даты по порядку и сам по себе разный — оба года словами, образец — вся фраза с годом в окне', () => {
    expect(text('открой 5 ноября и 22 октября, 8 мест')).toBe('22 октября — 2026 или 2027 год? По порядку дат во фразе и само по себе '
      + 'выходит разное — не угадываю. Напишите фразу с годом: «открой 5 ноября и 22 октября 2026, 8 мест» или «открой 5 ноября и '
      + '22 октября 2027, 8 мест». Ничего не открыто.');
    // Отрезок — год после месяца конца; год за горизонтом в образец не идёт (восьмой ревью, S3).
    expect(text('открой 5 ноября и с 20 по 25 октября, 8 мест')).toBe('20 октября — 2026 или 2027 год? По порядку дат во фразе и '
      + 'само по себе выходит разное — не угадываю. Напишите фразу с годом: «открой 5 ноября и с 20 по 25 октября 2026, 8 мест». '
      + 'Ничего не открыто.');
    // Месяц: те же дни недели, год после месяца.
    expect(text('открой 3 августа и субботы июля, 8 мест')).toBe('Июль — 2027 или 2028 год? По порядку дат во фразе и само по себе '
      + 'выходит разное — не угадываю. Напишите фразу с годом: «открой 3 августа и субботы июля 2027, 8 мест». Ничего не открыто.');
    // Фраза с годом не годится (62 даты, второй год за горизонтом) — образца нет, а не неверный образец.
    expect(text('открой весь январь и весь декабрь')).toBe('Декабрь — 2026 или 2027 год? По порядку дат во фразе и само по себе '
      + 'выходит разное — не угадываю. Напишите год после месяца. Ничего не открыто.');
  });
  it('«до» — оба прочтения: вся фраза оператора с «по», его же словами', () => {
    expect(text('открой с 1 до 10 июля, 8 мест')).toBe('До 10 июля 2027 — входит ли этот день, не угадываю: так пишут и включительно, '
      + 'и нет. Напишите с предлогом по: «открой с 1 по 10 июля, 8 мест» или «открой с 1 по 9 июля, 8 мест». Ничего не открыто.');
    expect(text('открой сб и вс с 1 до 15 июля')).toContain('«открой сб и вс с 1 по 15 июля» или «открой сб и вс с 1 по 14 июля»');
    expect(text('открой с 03.07 до 10.07 на Горелый, 4 места', [{ id: '1', title: 'Вулкан Горелый', active: true }]))
      .toContain('«открой с 03.07 по 10.07 на Горелый, 4 места» или «открой с 03.07 по 09.07 на Горелый, 4 места»');
    // День раньше — уже не отрезок: такого варианта нет.
    expect(text('открой с 22 до 23 октября, 8 мест')).toContain('Напишите с предлогом по: «открой с 22 по 23 октября, 8 мест». ');
    // «сб и вс» остаются словами оператора: «выходные» при туре «Выходные» были бы отказом.
    expect(text('открой сб и вс с 1 до 15 июля', [{ id: '8', title: 'Выходные', active: true }])).toContain('«открой сб и вс с 1 по 15 июля»');
  });
  it('одинаковые концы — образец: то же без отрезка (восьмой ревью, m2)', () => {
    expect(text('открой сб-сб в июле, 8 мест')).toBe('Отрезок начинается и кончается одним и тем же днём или месяцем — '
      + 'не понял, что открыть. Если нужно это — напишите «открой субботы июля, 8 мест». Ничего не открыто.');
    expect(text('открой со среды по среду в июле, 8 мест')).toContain('«открой среды июля, 8 мест»');
    expect(text('открой с 3 по 3 августа, 8 мест')).toContain('«открой 3 августа, 8 мест»');
    expect(text('открой субботы с октября по октябрь')).toContain('«открой субботы октября»');
  });
  it('тур со словом даты в названии — кнопкой или после слова «тур», образец — даты самой фразы', () => {
    const tours: ChatTour[] = [{ id: '3', title: 'Выходные на Авачинском', active: true }];
    expect(text('открой выходные на Авачинском весь июль, 8 мест', tours)).toBe('«выходные» — это даты или тур «Выходные на Авачинском»? '
      + 'Напишите даты без названия тура — тур выберете кнопкой, например «открой весь июль, 8 мест», — или назовите его после слова '
      + 'тур: «открой весь июль тур Выходные на Авачинском, 8 мест». Ничего не открыто.');
    // Образцы — фразы, которые разбор принимает с этим туром.
    expect(parseDatesPhrase('открой весь июль тур Выходные на Авачинском, 8 мест', nowMs, tours))
      .toMatchObject({ kind: 'proposal', seats: 8, tour: { kind: 'one', id: '3' } });
    const gorely: ChatTour[] = [{ id: '2', title: 'Горелый по субботам', active: true }];
    expect(text('открой 3 августа на Горелый по субботам, 8 мест', gorely))
      .toContain('или назовите его после слова тур: «открой 3 августа тур Горелый по субботам, 8 мест».');
  });
  it('исключение в названии тура — «тур …», образец — даты самой фразы (восьмой ревью, S2)', () => {
    const tours: ChatTour[] = [{ id: '10', title: 'Занятия на вулкане', active: true }];
    expect(text('открой 3 августа на Занятия на вулкане, 8 мест', tours)).toBe('«занятия» — это исключение дат или тур «Занятия на вулкане»? '
      + 'Не угадываю. Тур с таким словом называйте после слова тур: «открой 3 августа тур Занятия на вулкане, 8 мест» — или '
      + 'напишите даты без названия тура, тур выберете кнопкой. Ничего не открыто.');
  });
});

describe('гид со своими турами (29.10): ссылки и слова — его кабинета', () => {
  const GUIDE_URL = /https?:\/\/\S+\/hub\/guide\/own/;
  const at = new Date('2026-10-22T02:32:00Z');
  /** Каждый текст потока со ссылкой или словами «кто включает» — для гида. */
  const guideTexts = (): string[] => [
    outcomeText(done(ALL, 3), 'guide'),
    outcomeText({ kind: 'refused', reason: 'tour_inactive', title: 'Сплав' }, 'guide'),
    repeatText(at, done(ALL, 3), 'guide'),
    repeatText(at, null, 'guide'),
    proposalText({
      tourTitle: 'Вулкан Горелый', seats: 8, dates: ALL.map((r) => r.date).sort(), perDate: ALL,
      facts: { maxParticipants: 6, isPublished: false, days: 1 }, autoConfirm: false, priceMentioned: false, weekdayWords: false,
      seller: 'guide',
    }).text,
    FLOW_TEXT.closeIntent('guide'), FLOW_TEXT.switchedOff('guide'), FLOW_TEXT.noAccount('guide'), FLOW_TEXT.noTours('guide'),
    FLOW_TEXT.hidden('Сплав', 'guide'), FLOW_TEXT.hiddenTours(['Сплав', 'Рыбалка'], 'guide'),
    telegramDatesText('guide'),
    ...(['negated', 'exclusion'] as const).map((reason) => refusalText({ kind: 'refused', reason, word: 'кроме' }, TODAY, 'guide')),
    refusalText({ kind: 'refused', reason: 'mixed_actions' }, TODAY, 'guide'),
    refusalText({ kind: 'refused', reason: 'question' }, TODAY, 'guide'),
    refusalText({ kind: 'refused', reason: 'too_many', count: 44, seats: 8, parts: [] }, TODAY, 'guide'),
    refusalText({ kind: 'refused', reason: 'too_many', count: 62, seats: 8, parts: ['весь июль', 'весь август'] }, TODAY, 'guide'),
    refusalText({ kind: 'refused', reason: 'seats_delta', word: 'ещё' }, TODAY, 'guide'),
    askText({ kind: 'ask', what: 'month_scope', month: 7, year: 2027, fromDay: 1, seats: 8 }, TODAY, 'guide'),
  ];

  it('каждая ссылка — раздел «Свои туры»; кабинета оператора, «Показать» и «Активен» нет ни в одном тексте', () => {
    const texts = guideTexts();
    for (const t of texts) {
      expect(t, t).not.toMatch(/\/hub\/operator|«Показать»|«Активен»|карточке тура/);
    }
    // Ссылка есть там, где у туроператора она есть: число текстов со ссылкой то же.
    const withLink = texts.filter((t) => GUIDE_URL.test(t));
    const opTexts = [
      outcomeText(done(ALL, 3), 'operator'), repeatText(at, done(ALL, 3), 'operator'), repeatText(at, null, 'operator'),
      FLOW_TEXT.closeIntent('operator'), FLOW_TEXT.switchedOff('operator'), FLOW_TEXT.noAccount('operator'),
      FLOW_TEXT.noTours('operator'), telegramDatesText('operator'),
    ];
    for (const t of opTexts) expect(t).toMatch(/\/hub\/operator\/(calendar|tours)/);
    expect(withLink.length).toBeGreaterThanOrEqual(opTexts.length + 6);
  });

  it('итог и превью: закрытое — в «Своих турах», сезон и черновик — у менеджера Ведара', () => {
    const t = outcomeText(done(ALL, 3), 'guide');
    expect(t).toMatch(/закрыты вами \(1\): 17 июля 2027 \(«Шторм &lt;b&gt;»\) — открыть их снова можно в кабинете, в разделе «Свои туры»\./);
    expect(t).toMatch(/вне сезона тура \(1\): 5 октября 2027 — сезон 1 мая 2027 — 30 сентября 2027; сезон тура меняет менеджер Ведара\./);
    expect(t).toMatch(/Проверить: https?:\/\/\S+\/hub\/guide\/own$/);
    const preview = guideTexts()[4]!;
    expect(preview).toMatch(/Тур — черновик, туристы даты пока не видят: пришлите описание менеджеру Ведара, и тур появится на сайте\./);
    expect(preview).not.toMatch(/Тур не опубликован/);
  });

  it('скрытый тур, нет туров, нет кабинета — кто включает и куда идти, словами гида', () => {
    expect(FLOW_TEXT.hidden('Сплав <b>', 'guide')).toBe('Тур «Сплав &lt;b&gt;» скрыт — туристы его не видят, и даты ему не открыты. '
      + 'Включает его менеджер Ведара; после включения откройте даты ещё раз — сами они не откроются. Ничего не открыто.');
    expect(FLOW_TEXT.hiddenTours(['Сплав'], 'guide')).toBe(FLOW_TEXT.hidden('Сплав', 'guide'));
    expect(FLOW_TEXT.hiddenTours(['Сплав', 'Рыбалка'], 'guide')).toMatch(/скрыты — .*Включает их менеджер Ведара.*Ничего не открыто\.$/);
    expect(FLOW_TEXT.noTours('guide')).toMatch(/^У вас нет активных туров — открывать даты некуда\. Скрытый тур включает менеджер Ведара\. Ваши туры: https?:\/\/\S+\/hub\/guide\/own$/);
    expect(FLOW_TEXT.noAccount('guide')).toMatch(/^Открывать даты из чата может только гид с кабинетом на Ведаре.*Ничего не открыто\. Даты открывает менеджер Ведара или вы — после входа: https?:\/\/\S+\/hub\/guide\/own$/);
    expect(telegramDatesText('guide')).toMatch(/^Открыть даты словами можно в MAX — там есть кнопка подтверждения\. Или в кабинете: https?:\/\/\S+\/hub\/guide\/own$/);
  });

  it('история помощника называет гида гидом; продавец по карточке — гид или оператор', () => {
    expect(historyAsk('Вулкан Горелый', ['2027-07-03'], 4, 'guide')).toBe('Гид попросил в чате открыть 1 дату (3 июля 2027) тура «Вулкан Горелый» по 4 места.');
    expect(historyResult({ kind: 'refused', reason: 'tour_not_found' }, 'guide')).toMatch(/больше не этого гида\.$/);
    expect(datesSellerOf({ category: 'guide' })).toBe('guide');
    expect(datesSellerOf({ category: 'operator' })).toBe('operator');
  });

  it('нажатие, чей чат не проверен, — без ссылки: неизвестно, чей кабинет', () => {
    expect(FLOW_TEXT.pressUnverifiedPartner).toMatch(/^Не смог проверить нажатие — ничего не изменено\./);
    expect(FLOW_TEXT.pressUnverifiedPartner).not.toMatch(/https?:/);
  });
});
