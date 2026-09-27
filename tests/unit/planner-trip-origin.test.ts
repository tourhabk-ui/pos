/**
 * Сторож: планер не считает, что человек прилетает.
 *
 * ── Что нашлось 27.09 (владелец: «есть же туристы, живущие на Камчатке, им не
 * нужна привязка к рейсу, им главное скидки») ──────────────────────────────
 *
 * Прогон живого движка на семи днях, до правки:
 *
 *   1 [arrival ] Прилёт днём. Размещение, акклиматизация. Прогулка по городу
 *   2 [activity] вулканы — Авачинская зона
 *   3 [rest    ] День отдыха. Термальные источники
 *   4 [activity] рыбалка — Авачинская зона
 *   5 [activity] Свободный день. Город, сувениры, рыбный рынок
 *   7 [departure] Сборы утром. Трансфер в аэропорт, вылет днём
 *   жильё 28 000-42 000 · транспорт 2 500-5 000
 *
 * Жителю Петропавловска здесь неправда всё, что не про вулканы: он не
 * прилетал, не акклиматизировался, в аэропорт не поедет и ночует у себя. Цена
 * этой неправды считается:
 *
 *   • ДВА дня из семи отданы самолёту, которого нет. На пяти днях это 40%
 *     поездки. Из-за них же не влезала связка в Западную зону (переезд + день
 *     там + возвращение = 3 дня), и рыбалка молча исчезала из плана;
 *   • ночь размещения за каждый день, включая ночи в своём городе:
 *     28 000-42 000 ₽ вместо 16 000-24 000 при comfort;
 *   • 2 500-5 000 ₽ трансфера аэропорта безусловной строкой;
 *   • «Перелёт 8-9 часов из Москвы + джетлаг» в предупреждении о короткой
 *     поездке.
 *
 * После правки тот же запрос с `tripOrigin: 'local'` даёт семь рабочих дней,
 * связку в Западную зону целиком и жильё 16 000-24 000.
 *
 * ── Чего сторож НЕ разрешает ──────────────────────────────────────────────
 *
 * Служебные дни решаются ОДИН раз (`framingDays`). Граница `tripDays -
 * departureDays` стоит в движке девять раз, и `const departureDays = 1`
 * рядом с ней — это правило, написанное десятый раз (§12). Поэтому сторож
 * держит и форму кода: безусловной единицы в этом месте быть не должно.
 *
 * Допущение о доме местного (Авачинская зона) обязано говориться словами:
 * адреса платформа не знает, и занизить счёт на догадке молча нельзя (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRIP_ORIGINS, TRIP_ORIGIN_LABEL, asTripOrigin, framingDays, activeBudget,
  arrivalDayText, departureDayText, nightIsAtHome, paysAirportTransfers,
  LOCAL_HOME_ZONE, HOME_NIGHTS_ASSUMPTION,
} from '@/lib/planner/trip-origin';

const ROOT = process.cwd();
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf-8');
/** Код без комментариев: в них старая форма описана — и должна быть. */
const CODE = ENGINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CLIENT = readFileSync(join(ROOT, 'app/planner/_PlannerClient.tsx'), 'utf-8');
const API = readFileSync(join(ROOT, 'app/api/planner/recommend/route.ts'), 'utf-8');

describe('служебные дни — следствие происхождения', () => {
  it('у прилетающего два: прилёт и вылет', () => {
    expect(framingDays('visitor')).toEqual({ arrival: 1, departure: 1 });
  });

  it('у местного ни одного — и это не «ноль по умолчанию»', () => {
    expect(framingDays('local')).toEqual({ arrival: 0, departure: 0 });
  });

  it('бюджет дней у местного на два больше при том же сроке', () => {
    expect(activeBudget(7, 'visitor')).toBe(5);
    expect(activeBudget(7, 'local')).toBe(7);
    expect(activeBudget(5, 'local') - activeBudget(5, 'visitor')).toBe(2);
  });

  it('бюджет не уходит в минус: однодневная поездка приезжего вся в дороге', () => {
    expect(activeBudget(1, 'visitor')).toBe(0);
    expect(activeBudget(0, 'visitor')).toBe(0);
  });

  it('неизвестное значение читается как «прилетает» — прежнее поведение', () => {
    expect(asTripOrigin(undefined)).toBe('visitor');
    expect(asTripOrigin('чепуха')).toBe('visitor');
    expect(asTripOrigin('local')).toBe('local');
  });

  it('у каждого происхождения есть подпись для формы', () => {
    for (const o of TRIP_ORIGINS) {
      expect(TRIP_ORIGIN_LABEL[o]?.label, `${o}: нет подписи`).toBeTruthy();
      expect(TRIP_ORIGIN_LABEL[o]?.hint, `${o}: нет пояснения`).toBeTruthy();
    }
  });
});

describe('дни самолёта у местного не сочиняются', () => {
  it('у местного нет ни строки прилёта, ни строки вылета', () => {
    expect(arrivalDayText('local')).toBeNull();
    expect(departureDayText('local')).toBeNull();
    expect(arrivalDayText('local', '08:00')).toBeNull();
    expect(departureDayText('local', '22:00')).toBeNull();
  });

  it('у прилетающего строки зависят от часа рейса, как и раньше', () => {
    expect(arrivalDayText('visitor', '08:00')?.title).toContain('утром');
    expect(arrivalDayText('visitor', '14:00')?.title).toContain('днём');
    expect(arrivalDayText('visitor', '20:00')?.title).toContain('вечером');
    expect(departureDayText('visitor', '19:00')?.title).toContain('вечером');
    expect(departureDayText('visitor', '08:00')?.title).toContain('утром');
  });

  it('текст прилёта по-прежнему называет акклиматизацию — это про безопасность', () => {
    expect(arrivalDayText('visitor')?.description).toContain('Акклиматизация');
  });
});

describe('счёт местного не берёт денег за то, чего он не платит', () => {
  it('ночь в своей зоне местному не считается', () => {
    expect(nightIsAtHome('local', LOCAL_HOME_ZONE)).toBe(true);
  });

  it('ночь в дальней зоне считается и местному', () => {
    expect(nightIsAtHome('local', 'western')).toBe(false);
    expect(nightIsAtHome('local', 'northern')).toBe(false);
  });

  it('приезжему считается каждая ночь, включая Авачинскую зону', () => {
    expect(nightIsAtHome('visitor', LOCAL_HOME_ZONE)).toBe(false);
  });

  it('трансфер аэропорта — только у прилетающего', () => {
    expect(paysAirportTransfers('visitor')).toBe(true);
    expect(paysAirportTransfers('local')).toBe(false);
  });

  it('допущение о доме названо словами и зовёт поправить', () => {
    expect(HOME_NIGHTS_ASSUMPTION).toMatch(/Авачинской/);
    expect(HOME_NIGHTS_ASSUMPTION).toMatch(/другом районе/);
  });
});

describe('движок спрашивает правило, а не пишет своё', () => {
  it('число служебных дней берётся из правила, а не из константы', () => {
    expect(CODE).toMatch(/const departureDays = framing\.departure/);
    expect(CODE, 'безусловная единица вернулась в движок').not.toMatch(/const departureDays = 1/);
  });

  it('бюджет активных дней считает правило', () => {
    expect(CODE).toMatch(/framedActiveBudget\(tripDays, origin\)/);
    expect(CODE, 'движок снова вычитает служебные дни сам').not.toMatch(/tripDays - 1 - departureDays/);
  });

  it('день прилёта ставится только когда правило дало текст', () => {
    const idx = CODE.indexOf('if (arrivalDay) {');
    expect(idx, 'день прилёта снова ставится безусловно').toBeGreaterThan(0);
    expect(CODE.slice(idx, idx + 400)).toMatch(/type: 'arrival'/);
  });

  it('день вылета ставится только когда правило дало текст', () => {
    expect(CODE).toMatch(/if \(departureDay && dayNum <= tripDays\)/);
  });

  it('ночь у себя дома пропускается в счёте', () => {
    expect(CODE).toMatch(/if \(nightIsAtHome\(origin, sleepZone\)\) continue;/);
  });

  it('трансфер аэропорта в счёте спрашивает правило', () => {
    expect(CODE).toMatch(/paysAirportTransfers\(origin\)/);
    expect(CODE, 'безусловный трансфер вернулся в счёт').not.toMatch(/priceFrom, 0\) \+ 2500/);
  });

  it('допущение о доме доходит до предупреждений', () => {
    expect(CODE).toMatch(/type: 'home_nights'/);
    expect(CODE).toMatch(/HOME_NIGHTS_ASSUMPTION/);
  });

  it('тип предупреждения о доме объявлен вместе с производителем', () => {
    // Тип без производителя — провод в никуда (§10.09).
    expect(ENGINE).toMatch(/\| 'home_nights'/);
  });
});

describe('про самолёт не говорится тому, кто не летит', () => {
  it('предупреждение о короткой поездке у местного своё', () => {
    const idx = CODE.indexOf("type: 'duration', severity: 'important'");
    expect(idx).toBeGreaterThan(0);
    const block = CODE.slice(idx, idx + 700);
    expect(block).toMatch(/=== 'local'/);
    // У местного довод другой: погода переносит выход, запаса нет.
    expect(block).toMatch(/погода на Камчатке переносит/);
  });

  it('про прилёт и вылет в отказе по отдыху — только приезжему', () => {
    const idx = CODE.indexOf('место нужно прилёту, вылету');
    expect(idx).toBeGreaterThan(0);
    expect(CODE.slice(idx - 400, idx)).toMatch(/origin === 'local'/);
  });

  it('невозможное возвращение объясняется без вылета, если человек местный', () => {
    const idx = CODE.indexOf('вылет из города в тот же день невозможен');
    expect(idx).toBeGreaterThan(0);
    expect(CODE.slice(idx - 500, idx)).toMatch(/=== 'local'/);
  });
});

describe('связка формы, схемы и движка', () => {
  it('схема запроса принимает происхождение', () => {
    expect(API).toMatch(/tripOrigin: z\.enum\(\['visitor', 'local'\]\)\.optional\(\)/);
  });

  it('ошибка о датах не говорит про прилёт: у местного его нет', () => {
    expect(API, 'сообщение о датах снова про прилёт').not.toMatch(/позже даты прилёта/);
  });

  it('форма спрашивает и отправляет ответ', () => {
    expect(CLIENT).toMatch(/TRIP_ORIGINS\.map/);
    expect(CLIENT).toMatch(/tripOrigin,/);
    expect(CLIENT).toMatch(/setTripOrigin\(o\)/);
  });

  it('у местного форма не просит время рейса', () => {
    expect(CLIENT).toMatch(/\{!isLocal && \(/);
    expect(CLIENT).toMatch(/aria-label="Время прилёта"/);
  });

  it('потолок дней отдыха в форме считает то же правило, что движок', () => {
    // Иначе ползунок в форме и раскладка движка разошлись бы на два дня.
    expect(CLIENT).toMatch(/activeBudget\(span, tripOrigin\) - 1/);
    expect(CLIENT, 'форма снова вычитает служебные дни сама').not.toMatch(/Math\.max\(0, span - 3\)/);
  });

  it('подпись шага не обещает время рейсов всем', () => {
    expect(CLIENT, 'подпись шага снова про рейсы').not.toMatch(/Даты и время рейсов/);
  });
});
