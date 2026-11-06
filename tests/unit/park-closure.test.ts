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
  detectParkClosure, detectParkReopening, isIndefiniteClosure, NATURAL_PARK_SLUGS, parkClosureHours,
  PARK_CLOSURE_DEFAULT_HOURS, PARK_CLOSURE_HOLD_HOURS, PARK_CLOSURE_MAX_HOURS,
} from '@/lib/safety/park-closure';
import { alertTerm } from '@/lib/safety/alert-dates';
import { alertOrigin } from '@/lib/safety/alert-origin';
import { feedWhenLine } from '@/lib/safety/current-status';
import { alertStamp } from '@/components/safety/LiveStatus';
import { parkHoldSkip } from '@/lib/services/safety/park-closure-hold';
import { parkShortName, parkUnknownWords, PARK_UNKNOWN_MAX_DAYS } from '@/lib/services/safety/park-reopening';
import { classifyMchsItem, classifyMchsItems } from '@/lib/services/safety/seismic-parser';
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';
import { pushCopy, PUSH_TYPES_WITH_INSTRUCTION } from '@/lib/services/safety/push-copy';
import { alertGuidance } from '@/lib/safety/alert-guidance';
import { PLACE_SCOPED_TYPES, PARK_SCOPED_SQL, ALERT_MATCH_SQL, PARK_STATUS_UNKNOWN_SQL } from '@/lib/services/safety/alert-place-scope';

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
 * Гашение по сводке об открытии и «не знаю» после предела — в конце файла
 * и в pg-тесте alert-place-scope; здесь срок.
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

// ── Сводка об открытии и «не знаю» после предела (решение владельца 06.11) ──
//
// Закрытие на межсезонье держится до сводки об открытии; после предела —
// «статус не известен», а не «зелёный». Распознаватель открытия строже
// распознавателя закрытия: ложное открытие гасит настоящее закрытие, и место
// зеленеет. Проходы приёма на настоящем PostgreSQL —
// tests/integration/alert-place-scope.pg.test.ts.

describe('сводка об открытии парка распознаётся по предложению', () => {
  const NOV20 = new Date('2026-11-20T03:00:00Z');

  it('открытие сейчас: глагол впереди и позади, причастие, начало сезона, «все природные парки»', () => {
    const cases: Array<[string, string[]]> = [
      // Сводка Минтура 06.08 (mintur-bulletin-split.test.ts): глагол впереди.
      ['Открыты летние маршруты природного парка «Быстринский».', ['bystrinskiy']],
      ['В природном парке «Ключевской» летние маршруты также открыты, но передвижение в районах вулканов крайне небезопасно.', ['klyuchevskoy']],
      ['Посещение маршрутов в парке «Налычево» возобновлено', ['nalychevo']],
      ['Маршруты парка «Налычево» вновь открыты для посещения. Ранее они были закрыты на период межсезонья.', ['nalychevo']],
      // Пост турпортала 20.11.2025 (t.me/visitkamchatka41/3925).
      ['В природном парке «Южно-Камчатский» начинается снегоходный сезон!', ['yuzhno-kamchatsky']],
      // Сайт КГБУ 03.06.2026 и пост 27.10.2026 (4934).
      ['Природный парк «Вилючинский» открыт!', ['vilyuchinsky']],
      ['Сейчас доступен только «Вилючинский» природный парк.', ['vilyuchinsky']],
      // Сводка 05.11.2026 (4956): парк — именем в кавычках, без слова «парк».
      ['«Вилючинский» - маршруты открыты для посещения.', ['vilyuchinsky']],
      ['Все природные парки открыты для посещения', [...NATURAL_PARK_SLUGS]],
      // Прошедшее время — обычный оборот сезонного поста (ревью 06.11).
      ['Зимние маршруты в природном парке «Налычево» открылись', ['nalychevo']],
      ['В природном парке «Налычево» открылись зимние маршруты', ['nalychevo']],
      ['Открылись зимние маршруты природного парка «Налычево»', ['nalychevo']],
      ['Природный парк «Налычево» открылся для посещения', ['nalychevo']],
      // «Дорогие» — обращение, а не дорога.
      ['Дорогие друзья, маршруты природного парка «Налычево» вновь открыты для посещения!', ['nalychevo']],
      ['В природном парке «Вилючинский» начался зимний туристический сезон.', ['vilyuchinsky']],
      // Страница КГБУ 01.06.2026: закрытие трёх парков и открытый четвёртый —
      // в разных предложениях; открыт тот, что открыт.
      ['С 1 июня приостанавливается посещение зимних туристических маршрутов на территориях природных парков: «Быстринский», «Вилючинский», «Налычево». Для посещения туристов доступен природный парк «Южно-Камчатский».', ['yuzhno-kamchatsky']],
    ];
    for (const [t, parks] of cases) expect(detectParkReopening(t, NOV20)?.parks, t).toEqual(parks);
  });

  it('не открытие: исключение, отрицание одного из парков, условие, расписание, служебный объект, опасный сезон (ревью 06.11)', () => {
    // Каждый из этих текстов прежняя редакция читала открытием и гасила
    // живое закрытие: место становилось зелёным.
    for (const t of [
      'Все природные парки открыты, кроме «Налычево».',
      'Маршруты всех природных парков открыты, за исключением парка «Налычево».',
      'Сейчас открыты маршруты только в парке «Вилючинский», в «Налычево» маршруты не открыты.',
      'Маршруты природного парка «Налычево» открыты только после установления снежного покрова.',
      'Маршруты природного парка «Налычево» открыты только для групп с инструктором.',
      'Зимние маршруты природного парка «Налычево» открыты с декабря по апрель.',
      'Летние маршруты природного парка «Налычево» открыты с 15 июня по 30 сентября.',
      'В летний сезон маршруты природного парка «Налычево» открыты с 1 июня по 30 сентября.',
      'Летом маршруты природного парка «Налычево» доступны всем желающим.',
      'Все природные парки Камчатки открыты для вас круглый год! Приезжайте.',
      'Возобновлено движение автобусов до парка «Налычево».',
      'Возобновлена работа визит-центра Быстринского природного парка в селе Эссо.',
      'В природном парке «Налычево» возобновлено строительство нового кордона.',
      'В парке «Налычево» возобновлён приём заявок на зимние маршруты.',
      'Дорога в природный парк «Налычево» открыта.',
      'Тропы в парке «Налычево» доступны лишь частично.',
      'Для посещения доступны маршруты природного парка «Налычево» в районе кордона Пиначево',
      'Начался сезон охоты в Быстринском природном парке.',
      'Во всех природных парках края начался пожароопасный сезон.',
      'Начался рыболовный сезон в природном парке «Налычево».',
      'Из всех природных парков сейчас открыт только «Вилючинский» природный парк.',
      'Маршруты парка «Налычево» открыты с 01.12.',
      'Маршруты парка «Налычево» скоро будут открыты.',
      'В природном парке «Налычево» маршруты могут быть открыты к выходным.',
      // Исключение строкой ниже и список после двоеточия — часть парка, не парк.
      'В Быстринском природном парке открыты все маршруты\nкроме\n:\n- «Озеро Илмаган»',
      'На территории Сети природных парков доступны для посещения маршруты в природном парке «Ключевской»:\n- «По следам недавних извержений»',
    ]) expect(detectParkReopening(t, NOV20), t).toBeNull();
  });

  it('известный пропуск, записанный, а не скрытый: парки только в шапках блоков', () => {
    // t.me/visitkamchatka41/3971, 23.12.2025 — настоящее открытие сезона.
    // «Сеть природных парков» за все пять не считается: в блоках того же
    // поста бывает «в парке X маршруты пока не открыты». Пропуск держит
    // место в «не знаю», ложное открытие сделало бы его зелёным. Когда
    // распознаватель научится блокам, этот тест обязан смениться на
    // положительный.
    expect(detectParkReopening('Зимние маршруты открылись на территориях Сети природных парков', NOV20)).toBeNull();
  });

  it('не открытие: будущее, прежнее состояние, отрицание, вопрос, служебный объект, регистрация, один маршрут', () => {
    for (const t of [
      'Зимние маршруты природного парка «Налычево» будут открыты с 1 декабря',
      'Зимние маршруты природного парка «Налычево» будут открыты после установления снежного покрова',
      'Маршруты природного парка «Налычево» откроются после установления снежного покрова',
      'Маршруты парка «Налычево» будут доступны после установления снежного покрова',
      'Маршруты парка «Налычево» были открыты до 1 ноября',
      'Маршруты парка «Налычево» пока не открыты',
      'Все природные парки, кроме «Вилючинского», не доступны для посещения',
      'Открыты ли маршруты парка «Налычево»?',
      'Маршруты парка «Налычево» уже открыты?',
      'Визит-центр парка «Налычево» открыт с 7 ноября по будням.',
      'В парке «Налычево» открыт новый визит-центр',
      'Открыта регистрация групп на маршруты парка «Налычево»',
      'Регистрация на маршруты парка «Налычево» открыта',
      'Открыт маршрут «Вилючинский водопад» в парке «Вилючинский»',
      // Существительное, а не причастие (закрытие «Ключевского» 22.08.2026).
      'О возобновлении посещения маршрутов парка «Ключевской» будет сообщено дополнительно',
      'Ждём снега и открытия зимних маршрутов в остальных природных парках!',
      // Парк не назван в том же предложении — открытия парка нет.
      'Природный парк «Налычево». Маршруты открыты для посещения.',
      'Маршруты открыты для посещения',
    ]) expect(detectParkReopening(t, NOV20), t).toBeNull();
  });

  it('смешанное предложение — в пользу закрытия', () => {
    expect(detectParkReopening('В парке «Налычево» открыты зимние маршруты, в парке «Ключевской» маршруты закрыты на зимний сезон.', NOV20)).toBeNull();
    expect(detectParkReopening('Посещение маршрутов природного парка «Налычево», приостановленное на зимний период, вновь открыто.', NOV20)).toBeNull();
    // В другом предложении закрытие открытию не мешает: парк каждого — свой.
    expect(detectParkReopening('Маршруты парка «Ключевской» закрыты на зимний сезон. В парке «Вилючинский» маршруты открыты.', NOV20))
      .toEqual({ parks: ['vilyuchinsky'] });
  });

  it('«с 1 декабря открыты» — открытие, только когда день наступил по Камчатке; дня публикации нет — не открытие', () => {
    const t = 'С 1 декабря открыты зимние маршруты природного парка «Налычево»';
    expect(detectParkReopening(t, new Date('2026-11-20T03:00:00Z'))).toBeNull();
    // 30.11 13:00 UTC — уже 1 декабря на Камчатке (UTC+12).
    expect(detectParkReopening(t, new Date('2026-11-30T13:00:00Z'))).toEqual({ parks: ['nalychevo'] });
    expect(detectParkReopening(t)).toBeNull();
    // «открыты до 1 ноября» — за ним объявлено закрытие.
    expect(detectParkReopening('Маршруты парка «Налычево» открыты до 1 ноября', new Date('2026-10-25T00:00:00Z'))).toBeNull();
  });

  it('ни один текст закрытия из сторожей закрытия открытием не становится', () => {
    // Строки берутся из самих тестов закрытия: новый случай закрытия попадает
    // под это правило сам, без переписи здесь.
    const closures: string[] = [];
    for (const f of ['tests/unit/park-closure.test.ts', 'tests/unit/visitkamchatka-channel.test.ts']) {
      const src = readFileSync(f, 'utf-8');
      for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){20,})'|`([^`]{20,})`/g)) {
        const t = m[1] ?? m[2];
        if (detectParkClosure(t)) closures.push(t);
      }
    }
    expect(closures.length, 'тексты закрытия найдены, а не пусто').toBeGreaterThan(25);
    for (const t of closures) {
      expect(detectParkReopening(t, new Date('2026-11-06T02:00:00Z')), t).toBeNull();
      expect(detectParkReopening(t), t).toBeNull();
    }
  });
});

describe('классификатор: открытие парка — улика, рождённая истёкшей', () => {
  const PUB_0611 = '2026-11-06T02:00:00Z';

  it('park_reopening: уровень 0, срок 0 ч, без зон, с парками, своим id с днём', () => {
    const ev = classifyMchsItem('vk-1', '', 'Посещение маршрутов в природном парке «Налычево» возобновлено.', PUB_0611, 'https://t.me/visitkamchatka41/1', 'visitkamchatka');
    expect(ev).not.toBeNull();
    expect(ev!.alert_type).toBe('park_reopening');
    expect(ev!.severity).toBe(0);
    expect(ev!.expires_hours).toBe(0);
    expect(ev!.affected_zones).toEqual([]);
    expect(ev!.affected_parks).toEqual(['nalychevo']);
    expect(ev!.source_id).toMatch(/^visitkamchatka\/2026-11-06\/o[0-9a-z]+$/);
    // Пост с заголовком — тоже с днём: «Открытие зимних маршрутов» выходит каждый год.
    const titled = classifyMchsItem('k-1', 'Открытие зимних маршрутов', 'В природном парке «Вилючинский» начинается зимний сезон!', PUB_0611, 'https://kamgov.ru/x', 'kamgov');
    expect(titled?.alert_type).toBe('park_reopening');
    expect(titled?.source_id).toMatch(/^kamgov\/2026-11-06\/o/);
  });

  it('открытие — только из сводок о доступности: ленты МЧС и MAX его не дают (ревью 06.11)', () => {
    const text = 'Маршруты природного парка «Налычево» вновь открыты для посещения туристов.';
    for (const prefix of ['mchs', 'vk_mchs', 'max_mchs']) {
      for (const ev of classifyMchsItems('m-1', '', text, PUB_0611, 'https://x', prefix)) {
        expect(ev.alert_type, prefix).not.toBe('park_reopening');
      }
    }
    for (const prefix of ['visitkamchatka', 'kamgov', 'kamtoday']) {
      expect(classifyMchsItem('b-1', '', text, PUB_0611, 'https://x', prefix)?.alert_type, prefix).toBe('park_reopening');
    }
  });

  it('запрет туристам в тексте открытия не поднимает его до тревоги', () => {
    const ev = classifyMchsItem('vk-2', '', 'Маршруты парка «Вилючинский» вновь открыты для посещения. Туристическим группам рекомендуется воздержаться от выхода на маршруты в горы.', PUB_0611, 'https://t.me/visitkamchatka41/2', 'visitkamchatka');
    if (ev?.alert_type === 'park_reopening') {
      expect(ev.severity).toBe(0);
      expect(ev.expires_hours).toBe(0);
    } else {
      // Текст взяла другая ветка — тогда это не открытие вовсе.
      expect(ev?.alert_type).not.toBe('park_reopening');
    }
  });

  it('закрытие в тексте сильнее: смешанное — park_closure, открытия нет', () => {
    const ev = classifyMchsItem('vk-3', '', 'В парке «Налычево» открыты зимние маршруты, в парке «Ключевской» маршруты закрыты на зимний сезон.', PUB_0611, 'https://vk.com/x', 'vk_mchs');
    expect(ev?.alert_type).toBe('park_closure');
  });

  it('текст, взятый другой веткой, открытием не становится: перекрытие маршрутов — перекрытие', () => {
    const ev = classifyMchsItem('k-2', '', '«Налычево» – летние маршруты открыты. Из-за сохраняющейся паводковой ситуации закрыты автомобильный маршрут «Радыгино – Центральный» и транзитный пеший маршрут.', PUB_0611, 'https://x', 'visitkamchatka');
    expect(ev?.alert_type).not.toBe('park_reopening');
  });

  it('открытие — не тревога ленты и не руководство: род вне FEED, «не знаю» — в ленте', () => {
    expect(FEED_ALERT_TYPES as readonly string[]).not.toContain('park_reopening');
    expect(FEED_ALERT_TYPES as readonly string[]).toContain('park_status_unknown');
    expect(PUSH_TYPES_WITH_INSTRUCTION as readonly string[]).not.toContain('park_status_unknown');
  });
});

describe('«статус парка не известен»: слова, срок подписи, происхождение, руководство', () => {
  it('заголовок — имя парка из справочника и дата сводки о СЕЗОННОМ закрытии по Камчатке; об открытии — «мы не нашли»', () => {
    // 02.11 15:30 UTC — уже 3 ноября на Камчатке.
    const w = parkUnknownWords('Природный парк «Налычево»', {
      base_iso: '2026-11-02T15:30:00.000Z',
      title: 'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья',
      description: '',
    });
    expect(w.title).toBe('Статус парка «Налычево» не известен: последняя сезонная сводка от 03.11');
    expect(w.description).toBe('Сводка от 03.11 сообщала о закрытии маршрутов на межсезонье; сводку об открытии в лентах, которые читает Ведар, мы не нашли. Перед выходом уточните у дирекции парка.');
    // «Не было» — факт об источнике, которого мы не знаем: распознаватель
    // открытия строг и пропускает часть настоящих сводок (пост 3971).
    expect(`${w.title} ${w.description}`).not.toMatch(/не было/);
    // Корня «закрыт» в заголовке нет: «не знаю» не улика «парк закрыт».
    expect(w.title).not.toMatch(/закрыт/i);
    expect(parkShortName('Национальный парк «Вулканы Камчатки» — «Ключевской»')).toBe('Ключевской');
    expect(parkShortName('Южно-Камчатский природный парк')).toBe('Южно-Камчатский природный парк');
    expect(parkUnknownWords('Природный парк «Быстринский»', { base_iso: '2026-11-02T03:00:00.000Z', title: 'Маршруты парка «Быстринский» закрыты до особого распоряжения', description: null }).description)
      .toMatch(/без даты открытия/);
  });

  it('лента пишет «сообщение от» датой последней сводки, а не «действует до» нашей датой', () => {
    const at = '2026-11-02T03:00:00.000Z';
    const until = '2026-12-01T09:17:00.000Z';
    expect(alertTerm({ at, until })).toBe('source');
    expect(alertTerm({ at, until, type: 'park_status_unknown' })).toBe('technical');
    expect(alertStamp({ type: 'park_status_unknown', at, until })).toMatch(/^сообщение от /);
  });

  it('MCP: вывод Ведара, а не «опубликовано»; происхождение — Ведар, даже со ссылкой на пост MAX', () => {
    const line = feedWhenLine({ createdAt: '2026-11-02T03:00:00.000Z', expiresAt: '2026-11-24T00:00:00.000Z', manual: false, derived: true }, Date.parse('2026-11-24T00:00:00Z'));
    expect(line).toMatch(/^вывод Ведара по сводке о сезонном закрытии от 2 ноября/);
    // Предел — числом из константы и от той сводки, а не «от сегодня».
    expect(line).toContain(`не дольше ${PARK_UNKNOWN_MAX_DAYS} суток от той сводки`);
    expect(line).not.toMatch(/опубликовано/);
    expect(alertOrigin('park-unknown/nalychevo', 'https://max.ru/mchs41/AZ1')).toEqual({ key: 'park_unknown', label: 'Ведар: вывод из сводок о закрытии парка' });
  });

  it('руководство: уточнить в дирекции, не выходить без подтверждения, 112', () => {
    const g = alertGuidance('park_status_unknown');
    expect(g.known).toBe(true);
    expect(g.steps.length).toBeGreaterThanOrEqual(3);
    const all = g.steps.join(' ');
    expect(all).toMatch(/дирекци/);
    expect(all).toMatch(/не выходите, пока не подтвердили/);
    expect(all).toContain('112');
  });

  it('привязка — та же, что у закрытия парка; жёлтый — своим правилом крона после красных веток', () => {
    expect(PLACE_SCOPED_TYPES).toContain('park_status_unknown');
    expect(PLACE_SCOPED_TYPES as readonly string[]).not.toContain('park_reopening');
    expect(PARK_SCOPED_SQL).toMatch(/ea\.alert_type IN \('park_closure', 'park_status_unknown'\)/);
    expect(PARK_STATUS_UNKNOWN_SQL).toBe("ea.alert_type = 'park_status_unknown'");
    // SQL пересчёта статуса — артефакт, судится по смыслу: признак рода
    // проносится через matched → dedup → agg, а ветка жёлтого стоит после
    // всех красных и до ELSE 'green'. Исполнение предиката и привязки — в pg-тесте.
    const src = readFileSync('app/api/cron/safety-ingest/route.ts', 'utf-8');
    const fn = src.slice(src.indexOf('async function updateRealTimeStatus'), src.indexOf('async function dispatchPushAlerts'));
    expect(fn).toMatch(/COALESCE\(\$\{PARK_STATUS_UNKNOWN_SQL\}, false\) AS park_unknown/);
    expect(fn).toMatch(/SELECT DISTINCT ON \(lrs_id, title\) lrs_id, title, severity, zonal, park_unknown/);
    expect(fn).toMatch(/COALESCE\(bool_or\(park_unknown\), false\) AS park_unknown/);
    const yellow = fn.indexOf("WHEN agg.park_unknown THEN 'yellow'");
    expect(yellow).toBeGreaterThan(0);
    for (const red of ["WHEN agg.place_severity >= 2 THEN 'red'", "WHEN agg.zonal_severity >= 3 THEN 'red'", "WHEN volc.level >= 2 THEN 'red'"]) {
      expect(fn.indexOf(red), red).toBeGreaterThan(0);
      expect(fn.indexOf(red), red).toBeLessThan(yellow);
    }
    expect(yellow).toBeLessThan(fn.indexOf("ELSE 'green'"));
  });
});
