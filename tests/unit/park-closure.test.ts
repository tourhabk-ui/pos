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
import { detectParkClosure, parkClosureHours, PARK_CLOSURE_DEFAULT_HOURS } from '@/lib/safety/park-closure';
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
