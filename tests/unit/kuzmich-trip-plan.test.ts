/**
 * Кузьмич выдаёт план поездки в чате («Мой план 2.0», A-2; владелец 08.08:
 * «план мне нравится, реализуем»).
 *
 * Паттерн GuideGeek (планировщик в мессенджере), доведённый до сделки:
 * ответ Кузьмича — план по дням из движка + ссылка на публичную страницу
 * /plans/[slug] с бронью реальных туров. Персональной ссылки сознательно
 * нет: user_trips.user_id NOT NULL, анонимный share требовал бы миграцию.
 *
 * Сторож держит: инструмент зарегистрирован и звётся из core, интересы
 * парсятся из свободного русского текста, подбор пресета честный,
 * форматтер не падает на пустом плане.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseChatInterests, matchPreset, formatTripPlanForChat,
  buildRefusal, inSeasonInterests, parsePlanStart, startNote,
  readPlanDays, readPlanDaysFor, parseChatInterestsDetailed, planWarningLines,
  rangeDays, planStartRefusal, type PlanStart,
} from '@/lib/kuzmich/trip-plan-tool';
import { KUZMICH_TOOLS, validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { PLAN_PRESETS, type PlanPreset } from '@/lib/plans/presets';
import { ACTIVITY_NAMES, type DayPlan } from '@/lib/planner';

const ROOT = process.cwd();
const CORE = readFileSync(join(ROOT, 'lib/kuzmich/core.ts'), 'utf-8');

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Авачинский вулкан',
  description: '', activityType: 'volcano', priceFrom: 8500, priceTo: 12000,
  coords: [53.25, 158.75], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'moderate' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [],
  ...over,
});

describe('parseChatInterests: свободный русский текст → ключи движка', () => {
  it('понимает разговорные формулировки', () => {
    const keys = parseChatInterests('хотим вулканы, медведей и в конце на море');
    expect(keys).toContain('volcano');
    expect(keys).toContain('bears');
    expect(keys).toContain('boat_trip');
  });

  it('пусто → классика первой поездки, не пустой план', () => {
    expect(parseChatInterests('')).toEqual(['volcano', 'bears', 'thermal']);
  });
});

describe('matchPreset: ссылка на публичную страницу с бронью', () => {
  it('неделя с вулканами → недельный вулканический пресет', () => {
    const p = matchPreset(7, ['volcano', 'trekking', 'thermal']);
    expect(p?.slug).toBe('kamchatka-za-7-dney-vulkany');
  });

  it('интересы без пересечения с пресетами → без ссылки, а не наугад', () => {
    // geyser — ключ движка, которого нет ни в одном пресете. Раньше здесь был
    // snowmobile, но зимний кластер (kamchatka-zimoy) его законно покрыл.
    expect(matchPreset(7, ['geyser'])).toBeNull();
  });

  it('снегоходы → зимний кластер (появился с посадочными)', () => {
    expect(matchPreset(7, ['snowmobile'])?.slug).toBe('kamchatka-zimoy');
  });

  /**
   * Замер 19.09: «море», 7 дней → «Камчатка за 7 дней: рыбалка».
   *
   * Счёт был `overlap*10 - dayPenalty`, сравнение строгим `>`, и счёт 10
   * набирали СРАЗУ ЧЕТЫРЕ пресета. Побеждал не лучший, а первый в массиве —
   * рыболовный, потому что `boat_trip` стоит у него третьим в списке.
   * Порядок литералов в файле решал, что увидит турист.
   */
  it('море ведёт на страницу про море, а не про рыбалку', () => {
    const p = matchPreset(7, ['boat_trip']);
    expect(p?.slug).toBe('kamchatka-za-5-dney-okean');
    expect(p?.title).toContain('океан');
  });

  it('сезонная страница — только в свой месяц (проба MCP 29.09: июль → «в июне»)', () => {
    expect(matchPreset(7, ['volcano', 'bears'], PLAN_PRESETS, 7)?.slug).not.toBe('kamchatka-v-iyune');
    expect(matchPreset(3, ['thermal'], PLAN_PRESETS, 10)?.slug).not.toBe('kamchatka-v-iyune');
    expect(matchPreset(7, ['snowmobile'], PLAN_PRESETS, 1)?.slug).toBe('kamchatka-zimoy');
    expect(matchPreset(7, ['snowmobile'], PLAN_PRESETS, 7)?.slug).not.toBe('kamchatka-zimoy');
    expect(matchPreset(7, ['volcano', 'thermal', 'bears'], PLAN_PRESETS, 6)?.slug).toBe('kamchatka-v-iyune');
  });

  it('у каждой сезонной страницы записан её месяц', () => {
    for (const slug of ['kamchatka-v-iyune', 'kamchatka-v-sentyabre', 'kamchatka-zimoy']) {
      expect(PLAN_PRESETS.find((p) => p.slug === slug)?.months?.length, slug).toBeGreaterThan(0);
    }
  });

  it('ответ не зависит от порядка пресетов в массиве', () => {
    // Главное свойство. Пока оно держится, вернуть прежний дефект нельзя
    // никакой перестановкой литералов.
    const shuffled = [...PLAN_PRESETS].reverse();
    for (const asked of [['boat_trip'], ['volcano', 'trekking', 'thermal'], ['snowmobile'], ['fishing']]) {
      expect(
        matchPreset(7, asked, shuffled)?.slug,
        `порядок изменил ответ на ${asked.join('+')}`,
      ).toBe(matchPreset(7, asked)?.slug);
    }
  });

  it('заглавный интерес пресета весит больше побочного совпадения', () => {
    // `kamchatka-za-7-dney-rybalka` содержит boat_trip и точно попадает в
    // 7 дней — и всё равно проигрывает пятидневному «океану», у которого
    // boat_trip стоит в заголовке.
    expect(matchPreset(7, ['boat_trip'])?.slug).not.toBe('kamchatka-za-7-dney-rybalka');
    // Обратная сторона: рыбалка спрошена — рыболовный пресет и выигрывает.
    expect(matchPreset(7, ['fishing'])?.slug).toBe('kamchatka-za-7-dney-rybalka');
  });

  it('пресет, обещающий лишнее, проигрывает точному', () => {
    // «Всё лучшее» (шесть тем) — плохой ответ на одну спрошенную.
    expect(matchPreset(7, ['bears'])?.slug).toBe('kamchatka-za-7-dney-medvedi');
  });

  /**
   * Два слагаемых счёта на живых шестнадцати пресетах ничего не решают —
   * это показала проверка мутацией: снимаешь их, ответы те же. Оставить
   * их на веру значило бы держать в счёте слагаемое без последствий, то
   * есть объявление без источника (§10.09). Поэтому каждое проверяется
   * набором, где оно ЕДИНСТВЕННОЕ различие, — ради этого `matchPreset` и
   * принимает список пресетов параметром.
   */
  describe('слагаемые счёта проверяются там, где они решают', () => {
    const preset = (slug: string, days: number, interests: string[]): PlanPreset => ({
      slug, title: slug, days, interests, intro: '', description: '',
    });

    it('штраф за обещанное сверх: узкий пресет выигрывает у широкого', () => {
      // Оба попадают в дни и оба несут boat_trip заглавным. Отличаются
      // только тем, сколько обещают сверх спрошенного. Слаги выбраны так,
      // что без штрафа победил бы ШИРОКИЙ (ничья и алфавит).
      const wide = preset('a-shirokiy', 7, ['boat_trip', 'x1', 'x2', 'x3']);
      const tight = preset('b-uzkiy', 7, ['boat_trip']);
      expect(matchPreset(7, ['boat_trip'], [wide, tight])?.slug).toBe('b-uzkiy');
    });

    it('остаточная ничья решается слагом, а не позицией в массиве', () => {
      // Пресеты неразличимы по счёту. Без правила победил бы первый в
      // массиве — то есть снова порядок литералов.
      const second = preset('b-vtoroy', 7, ['boat_trip']);
      const first = preset('a-pervyy', 7, ['boat_trip']);
      expect(matchPreset(7, ['boat_trip'], [second, first])?.slug).toBe('a-pervyy');
      // И наоборот: перестановка ответ не меняет.
      expect(matchPreset(7, ['boat_trip'], [first, second])?.slug).toBe('a-pervyy');
    });
  });
});

describe('formatTripPlanForChat', () => {
  it('план по дням с ценами, предупреждением и обеими ссылками', () => {
    const text = formatTripPlanForChat(
      [day({ realPrice: 8500 }), day({ day: 2, title: 'Паратунка', activityType: 'thermal', priceFrom: 1500, realPrice: 1500 })],
      ['Сентябрь — штормовой сезон на воде.'],
      { slug: 'kamchatka-za-7-dney-vulkany', title: 'x' },
    );
    // Разделитель тысяч в ru-RU — неразрывный пробел, не привязываемся к нему.
    expect(text).toMatch(/День 1\. Авачинский вулкан — от 8.500.₽/);
    expect(text).toContain('День 2. Паратунка');
    expect(text).toContain('Важно:\n- Сентябрь');
    expect(text).toContain('/plans/kamchatka-za-7-dney-vulkany');
    expect(text).toContain('/planner');
  });

  it('цена — только у реального тура, ориентир движка ценой не называется (аудит MCP 29.09)', () => {
    const text = formatTripPlanForChat(
      [day({ title: 'вулканы — Авачинская зона', priceFrom: 5000 })],
      [], null,
    );
    expect(text).not.toMatch(/5.000/);
    expect(text).toContain('День 1. Вулканы — Авачинская зона');
  });

  it('разрыв в нумерации назван словами, а не пропущен молча', () => {
    const text = formatTripPlanForChat(
      [day({}), day({ day: 2 }), day({ day: 3 }), day({ day: 7, title: 'Вылет' })],
      [], null,
    );
    expect(text).toMatch(/Дни 4–6\. Не заполнены/);
    const one = formatTripPlanForChat([day({}), day({ day: 3 })], [], null);
    expect(one).toMatch(/День 2\. Не заполнен:/);
  });

  it('пустой план — честный ответ со ссылкой на планировщик, не тишина', () => {
    const text = formatTripPlanForChat([], [], null);
    expect(text).toContain('Не собрал план');
    expect(text).toContain('/planner');
  });

  it('дата, на которую считали, названа в плане', () => {
    // Турист просит «семь дней», а движок молча берёт месяц вперёд. Не
    // назвать дату значит выдать план на октябрь за план «на сейчас».
    const text = formatTripPlanForChat([day({})], [], null, {
      refusal: 'x', plannedFor: '19 октября',
    });
    expect(text).toContain('19 октября');
  });

  it('готовый отказ не подменяется вшитой строкой', () => {
    const text = formatTripPlanForChat([], [], null, {
      refusal: 'В октябре это уже не сезон: вулканы.', plannedFor: '19 октября',
    });
    expect(text).toBe('В октябре это уже не сезон: вулканы.');
  });
});

/**
 * Отказ собрать план — замер с прода 19.09.
 *
 * Прежний текст был вшит строкой: «попробуй назвать интересы иначе (вулканы,
 * рыбалка, медведи, море)». Планировщик считает поездку на `now + 30 дней`,
 * то есть в сентябре — на октябрь, а в октябре вулканы, рыбалка и медведи уже
 * вне сезонных окон движка. Три слова совета из четырёх вели обратно в тот же
 * отказ, и настоящая причина — месяц — не называлась вовсе.
 */
describe('отказ называет причину, а не гоняет по кругу', () => {
  it('в сезоне считается из окон движка, а не из списка в коде', () => {
    // Октябрь: вулканы/рыбалка/медведи закрыты, море и термалка идут.
    const october = inSeasonInterests(10);
    expect(october).toContain('boat_trip');
    expect(october).toContain('thermal');
    expect(october).not.toContain('volcano');
    expect(october).not.toContain('fishing');
    expect(october).not.toContain('bears');
    // Январь — другой набор, и он тоже не пуст: «ничего» было бы неправдой.
    expect(inSeasonInterests(1)).toContain('snowmobile');
    expect(inSeasonInterests(1)).not.toContain('boat_trip');
  });

  it('называет месяц и то, что именно не в сезоне', () => {
    const text = buildRefusal(10, ['volcano', 'bears'], 'https://vedarai.ru');
    expect(text).toContain('октябре');
    expect(text).toContain('вулканы');
    expect(text).toContain('медведи');
  });

  it('совет не повторяет то, на чём план и не собрался', () => {
    // Главный дефект прежнего текста: закрытое в этом месяце предлагалось
    // назвать снова.
    const text = buildRefusal(10, ['volcano', 'fishing', 'bears'], 'https://vedarai.ru');
    const advice = text.slice(text.indexOf('Что идёт'));
    for (const closed of ['вулканы', 'рыбалка', 'медведи']) {
      expect(advice, `${closed} снова в совете`).not.toContain(closed);
    }
    expect(advice).toContain('морские прогулки');
  });

  it('интересы в сезоне — отказ не врёт про сезон', () => {
    // План может не сложиться и по другой причине (нет туров, транспорт).
    // Тогда говорить «не сезон» про конкретные интересы нельзя.
    const text = buildRefusal(8, ['volcano'], 'https://vedarai.ru');
    expect(text).toContain('план не сложился');
    expect(text).not.toContain('уже не сезон');
  });

  it('ссылка на живой планировщик остаётся — там задают свои даты', () => {
    expect(buildRefusal(10, ['volcano'], 'https://vedarai.ru')).toContain('https://vedarai.ru/planner');
  });

  it('совет замкнут: что предложили, то и разберём обратно', () => {
    // Советовать слово, которого Кузьмич не понимает, значит послать туриста
    // в «не разобрал». Круг проверяется на всех двенадцати месяцах, а не на
    // одном: список сезонный и меняется вместе с календарём.
    for (let m = 1; m <= 12; m++) {
      for (const key of inSeasonInterests(m)) {
        const word = ACTIVITY_NAMES[key];
        expect(word, `нет слова для ${key}`).toBeTruthy();
        expect(parseChatInterests(word), `${word} (месяц ${m})`).toContain(key);
      }
    }
  });

  it('обработчик считает месяц от даты, на которую планирует', () => {
    // Иначе отказ назовёт сезон «сегодня», а план считался на месяц вперёд.
    const src = readFileSync(join(ROOT, 'lib/kuzmich/trip-plan-tool.ts'), 'utf-8');
    expect(src).toMatch(/const month = arrival\.getUTCMonth\(\) \+ 1/);
    expect(src).toContain('buildRefusal(month');
    // Вшитого перечня интересов в отказе больше нет.
    expect(src).not.toContain('назвать интересы иначе');
  });
});

/**
 * Когда считать поездку (решение владельца 19.09: «2 исправляй»; аудит
 * планировщика 07.11, M1 и M2; аудит MCP 25.10, п. 1).
 *
 * До 19.09 старт был зашит как `now + 30 дней`: спросить план на июль было
 * нельзя ничем. Потом разбор понял месяц, но не число: «15 июля» и «10–17
 * июля» считались на 10 июля без единого слова, «2027-02-30» — на 2 марта,
 * сегодняшняя дата — прошедшей, а непонятое — «через месяц». Исходы теперь:
 * по умолчанию, разобрано (с концом диапазона или без), уже прошло и отказ
 * без плана — у отказа даты нет вовсе, подставить её нечем.
 */
describe('parsePlanStart: когда ехать', () => {
  // 19.09 12:00 UTC — на Камчатке уже 20.09.
  const NOW = Date.parse('2026-09-19T12:00:00Z');
  // 06.11 13:00 UTC — на Камчатке 07.11, 01:00.
  const NOV7 = Date.parse('2026-11-06T13:00:00Z');
  const isoOf = (s: PlanStart) => ('date' in s ? s.date.toISOString().slice(0, 10) : null);
  const endOf = (s: PlanStart) => (s.kind === 'parsed' && s.end ? s.end.toISOString().slice(0, 10) : null);

  it('не сказано — через 30 камчатских суток, полночью этой даты', () => {
    const s = parsePlanStart(undefined, NOW);
    expect(s.kind).toBe('default');
    expect(isoOf(s)).toBe('2026-10-20');
    expect(s.kind === 'default' && s.date.getTime()).toBe(Date.parse('2026-10-20T00:00:00Z'));
    // Час назад на Камчатке было ещё 19.09 — и «через месяц» тоже на день раньше.
    expect(isoOf(parsePlanStart('  ', Date.parse('2026-09-19T11:00:00Z')))).toBe('2026-10-19');
  });

  it('месяц словом — ближайший будущий, а не этого года любой ценой', () => {
    // Сентябрь 2026 уже идёт: «в июле» значит июль 2027, а не прошедший.
    const july = parsePlanStart('хотим в июле', NOW);
    expect(july.kind).toBe('parsed');
    expect(isoOf(july)).toBe('2027-07-10');
    // А декабрь того же года ещё впереди.
    expect(isoOf(parsePlanStart('в декабре', NOW))).toBe('2026-12-10');
    // Год назван — он и берётся.
    expect(isoOf(parsePlanStart('в июле 2028', NOW))).toBe('2028-07-10');
  });

  it('«мая» — май, «марта» — март, «маяк» и «майские» — не май', () => {
    expect(isoOf(parsePlanStart('в мае', NOW))).toBe('2027-05-10');
    expect(isoOf(parsePlanStart('в марте', NOW))).toBe('2027-03-10');
    // Родительного падежа мая в старом списке форм не было вовсе (M1).
    expect(isoOf(parsePlanStart('15 мая', NOW))).toBe('2027-05-15');
    expect(isoOf(parsePlanStart('3 марта', NOW))).toBe('2027-03-03');
    expect(parsePlanStart('к маяку', NOW)).toEqual({ kind: 'invalid', raw: 'к маяку', reason: 'not_a_date' });
    expect(parsePlanStart('на майские', NOW).kind).toBe('invalid');
  });

  it('число месяца не теряется: «15 июля» — 15-е, а не 10-е (M1)', () => {
    for (const said of ['15 июля', '15-го июля', 'с 15 июля', '15.07', '15.07.2027', '15.07.27']) {
      const s = parsePlanStart(said, NOW);
      expect(s.kind, said).toBe('parsed');
      expect(isoOf(s), said).toBe('2027-07-15');
      expect(endOf(s), said).toBeNull();
    }
  });

  it('диапазон — начало и конец, длина считается с первым и последним днём (M1)', () => {
    for (const said of [
      '10–17 июля', 'с 10 по 17 июля', '10-17 июля 2027', 'между 10 и 17 июля',
      '10 июля — 17 июля', '10–17.07', '10.07–17.07.2027', '2027-07-10 — 2027-07-17',
    ]) {
      const s = parsePlanStart(said, NOW);
      expect(isoOf(s), said).toBe('2027-07-10');
      expect(endOf(s), said).toBe('2027-07-17');
      expect(rangeDays(s), said).toBe(8);
    }
  });

  it('диапазон через месяц и через Новый год', () => {
    const summer = parsePlanStart('28 июля — 3 августа', NOW);
    expect([isoOf(summer), endOf(summer), rangeDays(summer)]).toEqual(['2027-07-28', '2027-08-03', 7]);
    const ny = parsePlanStart('28 декабря — 5 января', NOW);
    expect([isoOf(ny), endOf(ny), rangeDays(ny)]).toEqual(['2026-12-28', '2027-01-05', 9]);
    // Год только у конца — начало в предыдущем году, а не за год до него.
    const named = parsePlanStart('28 декабря — 5 января 2028', NOW);
    expect([isoOf(named), endOf(named)]).toEqual(['2027-12-28', '2028-01-05']);
  });

  it('точная дата берётся как есть', () => {
    const s = parsePlanStart('2027-07-10', NOW);
    expect(s.kind).toBe('parsed');
    expect(isoOf(s)).toBe('2027-07-10');
  });

  it('такой даты нет — отказ без даты, а не соседний день (M2)', () => {
    // 2027-02-30 движок дат JS молча переносил на 2 марта.
    for (const said of ['2027-02-30', '30 февраля', '31.04', '31.04.2027', '2026-13-01', '31 июня 2027']) {
      const s = parsePlanStart(said, NOW);
      expect(s.kind, said).toBe('invalid');
      expect(s, said).not.toHaveProperty('date');
      expect(s.kind === 'invalid' && s.reason, said).toBe('no_such_date');
    }
    // 29 февраля без года — ближайший високосный, а не отказ.
    expect(isoOf(parsePlanStart('29 февраля', NOW))).toBe('2028-02-29');
  });

  it('конец раньше начала — отказ, а не поездка на год', () => {
    const s = parsePlanStart('17–10 июля', NOW);
    expect(s).toEqual({ kind: 'invalid', raw: '17–10 июля', reason: 'bad_range' });
  });

  it('сегодня по Камчатке — не прошлое (M2)', () => {
    // Сегодняшняя ISO-дата считалась прошедшей, и план уезжал на месяц вперёд.
    expect(parsePlanStart('2026-11-07', NOV7)).toMatchObject({ kind: 'parsed' });
    expect(isoOf(parsePlanStart('2026-11-07', NOV7))).toBe('2026-11-07');
    expect(isoOf(parsePlanStart('7 ноября', NOV7))).toBe('2026-11-07');
    expect(parsePlanStart('2026-11-06', NOV7).kind).toBe('past');
    // Тот же 06.11 по UTC, но на Камчатке ещё 06.11 — не прошлое.
    expect(parsePlanStart('2026-11-06', Date.parse('2026-11-06T11:00:00Z')).kind).toBe('parsed');
    expect(isoOf(parsePlanStart('сегодня', NOV7))).toBe('2026-11-07');
    expect(isoOf(parsePlanStart('завтра', NOV7))).toBe('2026-11-08');
    expect(isoOf(parsePlanStart('послезавтра', NOV7))).toBe('2026-11-09');
    // Число без года — ближайшее не раньше сегодня: 5 ноября уже было.
    expect(isoOf(parsePlanStart('5 ноября', NOV7))).toBe('2027-11-05');
    expect(isoOf(parsePlanStart('15 ноября', NOV7))).toBe('2026-11-15');
  });

  it('дата в прошлом — «так нельзя», а не «не понял»', () => {
    // Починка разная: одному надо назвать год, другому — сказать понятнее.
    for (const said of ['2020-07-10', '15 мая 2025', '10.07.2025']) {
      const s = parsePlanStart(said, NOW);
      expect(s.kind, said).toBe('past');
      expect(isoOf(s), said).toBe('2026-10-20');
    }
    expect(parsePlanStart('в октябре 2026', NOV7).kind).toBe('past');
    // Месяц назван с годом и ещё идёт — с сегодняшнего числа, а не «прошло».
    const midNov = Date.parse('2026-11-14T13:00:00Z');
    expect(isoOf(parsePlanStart('в ноябре 2026', midNov))).toBe('2026-11-15');
  });

  it('непонятое — отказ без даты, а не план «через месяц»', () => {
    // Агент, получивший план на другую дату, продолжает так, будто его дата
    // принята (аудит MCP 25.10, п. 1): это опаснее отказа.
    for (const said of ['когда-нибудь потом', 'летом', '1.5 месяца']) {
      const s = parsePlanStart(said, NOW);
      expect(s.kind, said).toBe('invalid');
      expect(s, said).not.toHaveProperty('date');
      expect(s.kind === 'invalid' && s.reason, said).toBe('not_a_date');
    }
  });
});

describe('planStartRefusal: отказ называет, что не так и как сказать иначе', () => {
  const NOW = Date.parse('2026-09-19T12:00:00Z');
  const refuse = (said: string) => {
    const s = parsePlanStart(said, NOW);
    if (s.kind !== 'invalid') throw new Error(`ждали отказ: ${said}`);
    return planStartRefusal(s);
  };

  it('нет в календаре', () => {
    const text = refuse('2027-02-30');
    expect(text).toContain('«2027-02-30» нет в календаре');
    expect(text).toContain('план не собран');
    expect(text).not.toMatch(/2027-03-0[12]|2 марта/);
  });

  it('не дата', () => {
    const text = refuse('Когда-нибудь потом');
    // Цитата — как сказано, без переделки регистра.
    expect(text).toContain('«Когда-нибудь потом» не разобрал как дату поездки');
    expect(text).toMatch(/«15 июля».*«10–17 июля».*2027-07-15/);
  });

  it('конец раньше начала', () => {
    expect(refuse('17–10 июля')).toContain('конец раньше начала');
  });
});

describe('startNote: про подмену даты говорят вслух', () => {
  const NOW = Date.parse('2026-09-19T12:00:00Z');
  const noted = (said: string | undefined, plannedFor: string) => {
    const s = parsePlanStart(said, NOW);
    if (s.kind === 'invalid') throw new Error(`отказ вместо даты: ${said}`);
    return startNote(s, plannedFor);
  };

  it('молчит там, где говорить не о чем', () => {
    expect(noted(undefined, '20 октября')).toBe('');
    expect(noted('в июле', '10 июля')).toBe('');
    expect(noted('15 июля', '15 июля')).toBe('');
    expect(noted('10–17 июля', '10 июля')).toBe('');
  });

  it('прошедшее названо прошедшим', () => {
    const note = noted('2020-07-10', '20 октября');
    expect(note).toContain('уже прошло');
    expect(note).toContain('20 октября');
  });
});

describe('readPlanDaysFor: длительность и диапазон в «когда»', () => {
  const NOW = Date.parse('2026-09-19T12:00:00Z');
  const range = parsePlanStart('10–17 июля', NOW);

  it('длительность не названа — длина диапазона', () => {
    expect(readPlanDaysFor(undefined, range)).toEqual({ days: 8, note: null });
    expect(readPlanDaysFor('  ', range)).toEqual({ days: 8, note: null });
  });

  it('совпадает с диапазоном — без слов', () => {
    expect(readPlanDaysFor('8', range)).toEqual({ days: 8, note: null });
  });

  it('расходится — названная длительность, и расхождение сказано', () => {
    // «10–17 июля» при days 7 — ночи вместо дней: последний день не теряется молча.
    const r = readPlanDaysFor('7', range);
    expect(r.days).toBe(7);
    expect(r.note).toContain('это 8 дней');
    expect(r.note).toContain('считаю 7 дней, 10 июля — 16 июля');
    expect(r.note).toContain('передай длительность 8');
  });

  it('слово вместо числа — по датам', () => {
    expect(readPlanDaysFor('неделю', range)).toEqual({
      days: 8, note: 'Длительность «неделю» не разобрал — считаю по датам: 8 дней.',
    });
  });

  it('диапазон длиннее 21 дня — граница вслух', () => {
    const long = parsePlanStart('1–30 июля', NOW);
    expect(rangeDays(long)).toBe(30);
    expect(readPlanDaysFor(undefined, long)).toEqual({ days: 21, note: 'План собираю до 21 дня — считаю 21, а не 30.' });
  });

  it('без диапазона — как прежде', () => {
    expect(readPlanDaysFor('10', parsePlanStart('15 июля', NOW))).toEqual({ days: 10, note: null });
    expect(readPlanDaysFor(undefined, parsePlanStart(undefined, NOW))).toEqual({ days: 7, note: null });
  });
});

describe('инструмент подключён', () => {
  it('make_trip_plan зарегистрирован и виден модели', () => {
    const names = KUZMICH_TOOLS.map((t) => t.function.name);
    expect(names).toContain('make_trip_plan');
  });

  it('аргументы валидируются: все необязательны, мусор не проходит', () => {
    expect(validateToolArgs('make_trip_plan', {}).ok).toBe(true);
    expect(validateToolArgs('make_trip_plan', { days: '7', interests: 'вулканы' }).ok).toBe(true);
    expect(validateToolArgs('make_trip_plan', { when: 'в июле' }).ok).toBe(true);
  });

  it('модель знает про «когда» — иначе аргумент мёртв (§10.09)', () => {
    // Поле в схеме, которого нет в описании инструмента, модель не заполнит
    // никогда: потребитель есть, производителя нет.
    const def = KUZMICH_TOOLS.find((t) => t.function.name === 'make_trip_plan');
    const props = def?.function.parameters?.properties as Record<string, { description?: string }> | undefined;
    expect(props?.when?.description).toBeTruthy();
    expect(props?.when?.description).toContain('месяц');
    // И обработчик его действительно получает.
    expect(CORE).toMatch(/makeTripPlanForKuzmich\(\{[^}]*when: args\.when/);
  });

  it('core зовёт обработчик', () => {
    expect(CORE).toMatch(/makeTripPlanForKuzmich/);
  });
});

describe('план не выдаёт служебное и прошлое за факт (аудит MCP 29.09)', () => {
  const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf-8');

  it('в тексте предупреждений нет ключа движка и английских уровней', () => {
    // «volcano: требуется уровень "active", у вас "moderate"» уходило туристу.
    expect(ENGINE).not.toMatch(/message: `\$\{interest\}:/);
    expect(ENGINE).not.toMatch(/требуется уровень "\$\{c\.fitnessRequired\}"/);
    expect(ENGINE).toContain('activityLabel(interest)');
  });

  it('тревога без срока не растягивается на поездку через год', () => {
    // Прежняя форма `active_until IS NULL OR ...` — «навсегда».
    expect(ENGINE).not.toMatch(/active_until IS NULL OR active_until >= \$1/);
    expect(ENGINE).toMatch(/active_until IS NULL\s+AND \$1::date <= CURRENT_DATE \+ \$3::int/);
  });
});

// Проверка MCP 29.09: предупреждения дня («Только с гидом», лимит парка) и
// безопасность уровня info («территория медведей») до ответа не доходили;
// «10 days» молча становилось семью; допущения движка не назывались.
describe('план говорит то, что знает движок', () => {
  const dayW = (over: Partial<DayPlan>): DayPlan => ({
    day: 2, type: 'activity', title: 'Трекинг — Восточная зона', description: '', zone: 'eastern',
    activityType: 'trekking', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking',
    allowedTransports: ['walking'], difficulty: 'moderate', childFriendly: true, minChildAge: 0,
    dayWarnings: [], ...over,
  } as DayPlan);

  it('предупреждения дня стоят под днём, лишние названы числом', () => {
    const text = formatTripPlanForChat([dayW({ dayWarnings: ['Только с гидом: перевал. Ищите тур оператора.', 'a', 'b', 'c'] })], [], null);
    expect(text).toMatch(/День 2\. Трекинг — Восточная зона\n {3}! Только с гидом: перевал/);
    expect(text).toMatch(/…и ещё 1 — в планировщике/);
  });

  it('все предупреждения плана, без молчаливого потолка в два', () => {
    const text = formatTripPlanForChat([dayW({})], ['один', 'два', 'Территория медведей. Гид с фальшфейером обязателен.'], null);
    expect(text).toMatch(/Территория медведей/);
  });

  it('длительность из слов модели и границы — вслух', () => {
    expect(readPlanDays('10 days')).toEqual({ days: 10, note: null });
    expect(readPlanDays('две недели').note).toMatch(/не разобрал — считаю 7/);
    expect(readPlanDays('30')).toEqual({ days: 21, note: expect.stringMatching(/считаю 21, а не 30/) });
  });

  it('инструмент оставляет safety-предупреждения уровня info и называет допущения', () => {
    // Справка безопасности уровня info доходит до агента, прочий info — нет.
    // Вызовом, а не литералом исходника (правило 13.10): весь состав «Важно»
    // держит tests/unit/planner-audit-wave1.
    expect(planWarningLines({
      warnings: [
        { type: 'crowd', severity: 'info', message: 'Умеренная загрузка' },
        { type: 'safety', severity: 'info', message: 'Территория медведей' },
      ],
      preferences: null,
    })).toEqual(['Территория медведей']);
    const src = readFileSync('lib/kuzmich/trip-plan-tool.ts', 'utf-8');
    // С #2223 строка допущений считается из названного состава и бюджета
    // (planAssumptions) и стоит последней — после поправок к словам туриста.
    // Поправки к возрасту детей нет с 29.10: неразобранный возраст — отказ
    // без плана (readChildren, tests/unit/mcp-plan-answer), а не заметка.
    expect(src).toMatch(/startNote\(start, plannedFor\), daysNote, interestsNote,\s*group\.note, budget\.note, assumptions,/);
    expect(parseChatInterestsDetailed('что-нибудь интересное')).toEqual({ interests: ['volcano', 'bears', 'thermal'], defaulted: true });
    expect(parseChatInterestsDetailed('рыбалка').defaulted).toBe(false);
  });
});
