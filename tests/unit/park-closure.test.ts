/**
 * Закрытие маршрутов природного парка — свой род тревоги (#2133, 30.09).
 *
 * «До 1 октября приостановлено посещение маршрутов в природных парках
 * „Налычево“ и „Южно-Камчатский“» (циклон, порывы до 32 м/с) не дошло ни до
 * одного места: Ведар отвечал по Налычево [ЗЕЛЁНЫЙ]. Привязку к местам судит
 * интеграционный тест на PostgreSQL (tests/integration/alert-place-scope.pg);
 * здесь — распознавание текста и связка рода с потребителями.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  detectParkClosure, isIndefiniteClosure, NATURAL_PARK_SLUGS, parkClosureHours,
  PARK_CLOSURE_DEFAULT_HOURS, PARK_CLOSURE_HOLD_HOURS, PARK_CLOSURE_MAX_HOURS,
} from '@/lib/safety/park-closure';
import { alertTerm } from '@/lib/safety/alert-dates';
import { parkHoldSkip } from '@/lib/services/safety/park-closure-hold';
import { classifyMchsItem } from '@/lib/services/safety/seismic-parser';
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';
import { pushCopy, PUSH_TYPES_WITH_INSTRUCTION } from '@/lib/services/safety/push-copy';
import { alertGuidance } from '@/lib/safety/alert-guidance';
import { PLACE_SCOPED_TYPES, PARK_SCOPED_SQL, ALERT_MATCH_SQL } from '@/lib/services/safety/alert-place-scope';

/** Текст в жанре новости 30.09 (kamtoday, eastrussia), дословно из выдачи. */
const CYCLONE =
  'До 1 октября приостановлено посещение маршрутов в природных парках «Налычево» и «Южно-Камчатский». ' +
  'В регионе ожидаются сильные дожди и ветер до 18-23 м/с, на юго-западном побережье порывы до 27-32 м/с. ' +
  'Туристическим группам рекомендуется воздержаться от выхода на маршруты.';

const PUB = '2026-09-30T02:00:00Z';

describe('распознавание закрытия парка', () => {
  it('новость 30.09: оба парка названы', () => {
    expect(detectParkClosure(CYCLONE)).toEqual({ parks: ['nalychevo', 'yuzhno-kamchatsky'] });
  });

  it('классификатор отдаёт park_closure, а не погоду и не дорогу; зон нет — привязка по парку', () => {
    const ev = classifyMchsItem('kt-1', '', CYCLONE, PUB, 'https://kamtoday.ru/x', 'kamtoday');
    expect(ev).not.toBeNull();
    expect(ev!.alert_type).toBe('park_closure');
    expect(ev!.severity).toBe(2);
    expect(ev!.affected_parks).toEqual(['nalychevo', 'yuzhno-kamchatsky']);
    expect(ev!.affected_zones).toEqual([]);
  });

  it('другие обороты закрытия', () => {
    for (const t of [
      'Временно закрыты туристические маршруты природного парка «Налычево»',
      'Посещение Быстринского природного парка приостановлено',
      'Запрещён выход на маршруты в Ключевском природном парке',
    ]) expect(detectParkClosure(t), t).not.toBeNull();
  });

  it('не закрытие: открытие, парк не назван, парк упомянут без решения', () => {
    expect(detectParkClosure('Посещение маршрутов в парке «Налычево» возобновлено')).toBeNull();
    expect(detectParkClosure('Туристические маршруты закрыты из-за циклона')).toBeNull();
    expect(detectParkClosure('В парке «Налычево» прошёл субботник')).toBeNull();
    // Частичное закрытие (сводка Минтура 11.09): открыто почти всё, закрыты
    // два названных маршрута — это не закрытие парка.
    expect(detectParkClosure('В парке «Налычево» летние маршруты открыты. Из-за сохраняющейся паводковой ситуации закрыты автомобильный маршрут «Радыгино — Центральный» и транзитный пеший маршрут.')).toBeNull();
    // Сопка, а не парк: «Ключевская сопка» без слова «парк» парком не считается.
    expect(detectParkClosure('Маршруты на Ключевскую сопку закрыты, парк культуры работает')).toBeNull();
  });

  it('«на всех территориях природных парков» (сводка 02.11) закрывает все природные парки', () => {
    const r = detectParkClosure('Со 2 ноября приостановлено посещение туристических маршрутов на всех территориях природных парков Камчатки');
    expect(r).not.toBeNull();
    expect([...r!.parks].sort()).toEqual([...NATURAL_PARK_SLUGS].sort());
    expect(r!.parks).toContain('yuzhno-kamchatsky');
    // Заповедники такая фраза не называет.
    expect(r!.parks).not.toContain('kronotsky');
    expect(r!.parks).not.toContain('komandorskiy');
  });

  it('настоящий заголовок 02.11: кавычки после «маршрутов» — имя источника, а не маршрута (#2980)', () => {
    // Правило «закрыт конкретный маршрут „…“» принимало «Вулканы Камчатки» за
    // название маршрута, и закрытие всех парков считалось частичным: 05.11
    // Налычево стояло ЗЕЛЁНЫМ при закрытии в ленте.
    const r = detectParkClosure('Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья');
    expect(r).not.toBeNull();
    expect([...r!.parks].sort()).toEqual([...NATURAL_PARK_SLUGS].sort());
    // Открытие тем же оборотом закрытием не становится.
    expect(detectParkClosure('Маршруты «Вулканы Камчатки»: возобновлено посещение на всех территориях природных парков')).toBeNull();
  });

  it('«Вилючинский» — природный парк, а не город Вилючинск и не перевал', () => {
    for (const t of [
      'Приостановлено посещение природного парка «Вилючинский»',
      'Временно закрыты маршруты в Вилючинском природном парке',
    ]) expect(detectParkClosure(t), t).toEqual({ parks: ['vilyuchinsky'] });
    // Сквер в городе Вилючинске — не природный парк.
    expect(detectParkClosure('Городской парк Вилючинска закрыт для посещения')).toBeNull();
    expect(detectParkClosure('В Вилючинске закрыт для посещения парк культуры')).toBeNull();
    // Перевал без слова «парк» парком не назван.
    expect(detectParkClosure('Проезд на Вилючинский перевал закрыт')).toBeNull();
  });
});

describe('срок закрытия', () => {
  it('«до 1 октября» — до конца дня по Камчатке', () => {
    const h = parkClosureHours(CYCLONE, new Date(PUB));
    // 30.09 02:00 UTC → 01.10 12:00 UTC (= 23:59 по Камчатке) — 34 часа.
    expect(h).toBe(34);
  });

  it('даты нет — срок по умолчанию; дата в прошлом — тоже', () => {
    expect(parkClosureHours('Маршруты парка «Налычево» закрыты', new Date(PUB))).toBe(PARK_CLOSURE_DEFAULT_HOURS);
    expect(parkClosureHours('закрыто до 1 сентября', new Date(PUB))).toBe(PARK_CLOSURE_DEFAULT_HOURS);
  });

  it('«до 5 января», опубликовано в декабре, — следующий год', () => {
    const h = parkClosureHours('закрыто до 5 января', new Date('2026-12-30T00:00:00Z'));
    expect(h).toBeGreaterThan(24 * 6);
    expect(h).toBeLessThan(24 * 8);
  });
});

describe('связка рода: производитель, привязка, потребители', () => {
  it('род в ленте, в пушах с инструкцией и в руководстве', () => {
    expect(FEED_ALERT_TYPES).toContain('park_closure');
    expect(PUSH_TYPES_WITH_INSTRUCTION).toContain('park_closure');
    expect(pushCopy({ alertType: 'park_closure', title: 'Закрыты маршруты парка «Налычево»' }).body).toMatch(/Не выходите на маршруты парка/);
    expect(alertGuidance('park_closure').known).toBe(true);
  });

  it('привязка — по парку: род место-привязанный, ветка парка в общем правиле', () => {
    expect(PLACE_SCOPED_TYPES).toContain('park_closure');
    expect(ALERT_MATCH_SQL).toContain(PARK_SCOPED_SQL.trim().slice(0, 60));
    expect(PARK_SCOPED_SQL).toMatch(/kr\.park_name ILIKE '%' \|\| pk\.search_term \|\| '%'/);
    expect(PARK_SCOPED_SQL).toMatch(/<> 'nearby'/);
  });

  it('запись тревоги несёт парки', () => {
    const src = readFileSync('lib/services/safety/seismic-parser.ts', 'utf-8');
    expect(src).toMatch(/magnitude, lat, lng, volcano_name, affected_parks/);
  });
});

describe('«все … природного парка X» — один парк, не все', () => {
  it('единственное число не закрывает все парки', () => {
    expect(detectParkClosure('Закрыты все маршруты природного парка «Налычево».')).toEqual({ parks: ['nalychevo'] });
  });
});

/**
 * Сезонное закрытие держится 21 сутки (решение владельца 06.11, «1 да»).
 * Гашение по сводке об открытии и «не знаю» после предела — следующая
 * правка; здесь только срок.
 *
 * Сводка 02.11 «на всех территориях природных парков на период межсезонья»
 * держалась недельным сроком до 09.11 — дальше Налычево стало бы ЗЕЛЁНЫМ при
 * закрытых маршрутах, ровно на даты поездок 10–17.11.
 */
describe('сезонное закрытие держится 21 сутки, а не 48 ч и не неделю', () => {
  const NOV6 = new Date('2026-11-06T02:00:00Z');
  const LIVE_0211 =
    'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья';

  it('межсезонье, зимний сезон, «до особого распоряжения» — 21 сутки, а не 48 ч и не неделя', () => {
    for (const t of [
      LIVE_0211,
      'Маршруты природного парка «Ключевской» закрыты на зимний сезон',
      'Посещение Кроноцкого заповедника приостановлено до особого распоряжения',
      'Маршруты парка «Налычево» закрыты до открытия зимнего сезона',
    ]) {
      expect(isIndefiniteClosure(t), t).toBe(true);
      expect(parkClosureHours(t, NOV6), t).toBe(PARK_CLOSURE_HOLD_HOURS);
    }
    expect(PARK_CLOSURE_HOLD_HOURS).toBe(21 * 24);
  });

  it('оперативное закрытие без даты (циклон) — по-прежнему 48 ч', () => {
    const t = 'Приостановлено посещение маршрутов в природном парке «Налычево» из-за циклона';
    expect(isIndefiniteClosure(t)).toBe(false);
    expect(parkClosureHours(t, NOV6)).toBe(PARK_CLOSURE_DEFAULT_HOURS);
  });

  it('классификатор даёт живой сводке 02.11 сезонный срок из любой ленты, не только недельной', () => {
    for (const prefix of ['visitkamchatka', 'max_mchs', 'vk_mchs', 'mchs']) {
      const ev = classifyMchsItem('t-0211', '', LIVE_0211, '2026-11-02T03:00:00Z', 'https://example.test/0211', prefix);
      expect(ev?.alert_type, prefix).toBe('park_closure');
      expect(ev?.expires_hours, prefix).toBe(PARK_CLOSURE_HOLD_HOURS);
    }
  });

  it('«закрыты до 1 декабря» 6 ноября — до 1 декабря, а не 48 ч (было: дата дальше двух недель — «опечатка»)', () => {
    const h = parkClosureHours('Маршруты природного парка «Налычево» закрыты до 1 декабря', NOV6);
    // 06.11 02:00 UTC → 01.12 12:00 UTC (конец дня по Камчатке): 25 суток и 10 ч.
    expect(h).toBe(25 * 24 + 10);
  });

  it('дата дальше 60 суток — закрытие держится как сезонное, а не 48 ч', () => {
    expect(PARK_CLOSURE_MAX_HOURS).toBe(60 * 24);
    expect(parkClosureHours('Маршруты парка «Налычево» закрыты до 1 марта', NOV6)).toBe(PARK_CLOSURE_HOLD_HOURS);
  });

  it('«зимние маршруты будут открыты с 1 декабря» — закрытие до 1 декабря, а не открытие', () => {
    const t = 'Маршруты природного парка «Налычево» закрыты на период межсезонья, зимние маршруты будут открыты с 1 декабря.';
    // Было: ветка «маршрут… открыт» ловила «будут открыты», текст не считался
    // закрытием парка и уходил дорожной веткой без парка — не красил никого.
    expect(detectParkClosure(t)).toEqual({ parks: ['nalychevo'] });
    // Открытие с 1 декабря — значит закрыто до конца 30 ноября по Камчатке:
    // 06.11 02:00 UTC → 30.11 12:00 UTC = 24 суток и 10 ч.
    expect(parkClosureHours(t, NOV6)).toBe(24 * 24 + 10);
    for (const f of [
      'Посещение парка «Налычево» закрыто, маршруты откроются с 15 декабря.',
      'Маршруты парка «Быстринский» закрыты; посещение планируется возобновить весной.',
    ]) expect(detectParkClosure(f), f).not.toBeNull();
  });

  it('открытие сейчас по-прежнему не закрытие — и в другом предложении тоже', () => {
    expect(detectParkClosure('Посещение маршрутов в парке «Налычево» возобновлено')).toBeNull();
    expect(detectParkClosure('Маршруты парка «Налычево» вновь открыты для посещения. Ранее они были закрыты на период межсезонья.')).toBeNull();
  });

  it('срок закрытия парка — наш, а не источника: лента пишет «сообщение от», а не «действует до»', () => {
    const at = '2026-11-02T03:00:00.000Z';
    const until = new Date(Date.parse(at) + PARK_CLOSURE_HOLD_HOURS * 3_600_000).toISOString();
    expect(alertTerm({ at, until })).toBe('technical');
    // Повтор сводки через неделю продлевает срок (GREATEST в saveEvent), и
    // разница «срок − публикация» уже не TTL: без рода лента написала бы
    // «действует до 30 нояб.» — даты, которой источник не называл.
    const extended = new Date(Date.parse(at) + (7 * 24 + PARK_CLOSURE_HOLD_HOURS) * 3_600_000).toISOString();
    expect(alertTerm({ at, until: extended })).toBe('source');
    expect(alertTerm({ at, until: extended, type: 'park_closure' })).toBe('technical');
    // Ручная запись остаётся ручной: «в ленте до».
    expect(alertTerm({ at, until: extended, type: 'park_closure', manual: true })).toBe('feed_window');
  });
});

/**
 * Случаи независимой проверки 06.11 (три линзы, 27 подтверждённых находок):
 * каждое — текст, на котором первая редакция правила ошибалась.
 */
describe('правило срока на текстах проверки 06.11', () => {
  const NOV6 = new Date('2026-11-06T02:00:00Z');
  const UNTIL_NOV30 = 24 * 24 + 10; // 06.11 02:00 UTC → 30.11 12:00 UTC

  it('открытие сейчас с оговоркой «другой маршрут откроется позже» — не закрытие парка', () => {
    expect(detectParkClosure('Посещение маршрутов природного парка «Налычево», приостановленное на зимний период, вновь открыто, а маршрут на Корякский вулкан откроется позже.')).toBeNull();
  });

  it('дата «открыт с …» не про маршруты срок не укорачивает: визит-центр, КПП', () => {
    for (const t of [
      'Посещение природного парка «Налычево» приостановлено на период межсезонья. Визит-центр парка открыт с 7 ноября по будням.',
      'Маршруты природного парка «Налычево» закрыты на период межсезонья; КПП на Вилючинском перевале открыт с 10 ноября.',
    ]) expect(parkClosureHours(t, NOV6), t).toBe(PARK_CLOSURE_HOLD_HOURS);
  });

  it('объявленное открытие уже наступило — двое суток, а не три недели', () => {
    const t = 'Маршруты природного парка «Налычево» закрыты на межсезонье и будут открыты с 6 ноября.';
    expect(parkClosureHours(t, new Date('2026-11-05T22:00:00Z'))).toBe(PARK_CLOSURE_DEFAULT_HOURS);
  });

  it('естественные формы даты открытия — закрыто до конца предыдущего дня', () => {
    for (const t of [
      'Маршруты природного парка «Налычево» закрыты на межсезонье. С 1 декабря откроются зимние маршруты.',
      'Маршруты природного парка «Налычево» закрыты на межсезонье, зимние маршруты откроются 1 декабря.',
      'Маршруты природного парка «Налычево» закрыты на межсезонье, зимние маршруты будут открыты для туристов 1 декабря.',
      'Маршруты природного парка «Налычево» закрыты на межсезонье. Открытие зимних маршрутов — 1 декабря.',
    ]) expect(parkClosureHours(t, NOV6), t).toBe(UNTIL_NOV30);
  });

  it('оперативное закрытие с напоминанием о сезоне в другом предложении — 48 ч, а не 21 сутки', () => {
    for (const t of [
      'Посещение маршрутов природного парка «Налычево» приостановлено из-за циклона. Напоминаем, что в зимний период выход на маршруты без регистрации в МЧС запрещён.',
      'Из-за циклона приостановлено посещение маршрутов в природном парке «Налычево». В межсезонье будьте особенно осторожны на дорогах.',
    ]) {
      expect(isIndefiniteClosure(t), t).toBe(false);
      expect(parkClosureHours(t, NOV6), t).toBe(PARK_CLOSURE_DEFAULT_HOURS);
    }
  });

  it('прошедшая дата, ушедшая переносом в следующий год, — как будто её нет', () => {
    const t = 'Из-за циклона приостановлено посещение маршрутов природного парка «Налычево». Ранее парк был закрыт до 1 октября.';
    expect(parkClosureHours(t, NOV6)).toBe(PARK_CLOSURE_DEFAULT_HOURS);
  });

  it('«маршруты до открытия сезона закрыты» и «осенне-зимний период» — сезонное закрытие', () => {
    const before = 'В природном парке «Налычево» туристические маршруты до открытия зимнего сезона закрыты';
    expect(detectParkClosure(before)).toEqual({ parks: ['nalychevo'] });
    expect(parkClosureHours(before, NOV6)).toBe(PARK_CLOSURE_HOLD_HOURS);
    expect(parkClosureHours('Маршруты природного парка «Налычево» закрыты на осенне-зимний период', NOV6)).toBe(PARK_CLOSURE_HOLD_HOURS);
  });

  it('проход по лежащим строкам: ручные, чужие и обрезанные — не трогает', () => {
    const feed = { title: 'Маршруты закрыты', description: '', external_id: 'visitkamchatka/2026-11-02/ttd4bul', source_url: 'https://t.me/s/visitkamchatka41' };
    expect(parkHoldSkip(feed)).toBeNull();
    // Ручная запись со ссылкой на пост в MAX: alertOrigin узнаёт её по адресу как ленту MAX.
    expect(parkHoldSkip({ ...feed, external_id: 'manual-zakrytie-parkov', source_url: 'https://max.ru/mchs41/AZ1' })).toBe('manual');
    // id, заданный администратором в форме канала, — не форма классификатора.
    expect(parkHoldSkip({ ...feed, external_id: 't.me/minturkam/555' })).toBe('foreign_id');
    // Описание обрезано saveEvent до 800: дата открытия могла остаться за краем.
    expect(parkHoldSkip({ ...feed, description: 'а'.repeat(800) })).toBe('clipped');
    expect(parkHoldSkip({ ...feed, title: 'а'.repeat(200) })).toBe('clipped');
  });
});
