/**
 * Сторож: многодневный тур занимает столько дней, сколько длится.
 *
 * ── Замер с прода 20.09 (MCP `get_tours`) ────────────────────────────────
 *
 * У «Камчатской рыбалки» семь живых туров из восьми, и главные —
 * многодневные: «Многодневный летний тур (5 дней)» за 140 000 ₽,
 * «Недельный рыболовный тур (7 дней)» за 196 000 ₽, «Семейный недельный
 * тур» за 150 000 ₽.
 *
 * В плане каждый занимал ОДИН день. Цикл сборки был устроен как «день =
 * одна итерация», а `durationHours` читался из базы и не использовался
 * нигде. Семидневная поездка показывалась как один день с туром за 140
 * тысяч плюс шесть дней, которые движок заполнял чем придётся: главный
 * продукт оператора план не мог представить в принципе.
 *
 * ── Что держит сторож ────────────────────────────────────────────────────
 *
 *   — длительность выводится из данных, и «не заполнено» ≠ «однодневный»;
 *   — многодневный тур занимает свои дни, а цена считается ОДИН раз;
 *   — тур, не влезающий в срок, пропускается ЦЕЛИКОМ, а не режется;
 *   — цикл, ставший `while`, обязан завершаться сам.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tourDaySpan, tourPlanSpan, MAX_TOUR_DAYS } from '@/lib/planner/tour-span';
import { tourDurationDays } from '@/lib/bookings/duration';

const ROOT = process.cwd();
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf8');

describe('длительность тура выводится из данных', () => {
  it('многодневные часы становятся днями', () => {
    expect(tourDaySpan(120)).toBe(5);   // «Многодневный летний тур (5 дней)»
    expect(tourDaySpan(168)).toBe(7);   // «Недельный рыболовный тур»
    expect(tourDaySpan(72)).toBe(3);
  });

  it('всё до суток включительно — один день', () => {
    // Восьмичасовой тур и суточный занимают в расписании один день: ночует
    // человек в обоих случаях один раз. Деление без порога дало бы ноль.
    for (const h of [2.5, 8, 10, 24]) expect(tourDaySpan(h), String(h)).toBe(1);
    expect(tourDaySpan(25)).toBe(2);
  });

  it('незаполненное — «не знаем», а не «однодневный»', () => {
    // Главный исход. Подмена незнания единицей — ровно то, из-за чего
    // пятидневка и стояла одним днём.
    expect(tourDaySpan(null)).toBeNull();
    expect(tourDaySpan(undefined)).toBeNull();
    expect(tourDaySpan(0)).toBeNull();
    expect(tourDaySpan(-5)).toBeNull();
    expect(tourDaySpan(Number.NaN)).toBeNull();
  });

  it('нелепая длительность отвергается, а не подрезается', () => {
    // Вернуть потолок при 5000 часах значило бы выдать догадку за данные.
    expect(tourDaySpan(MAX_TOUR_DAYS * 24)).toBe(MAX_TOUR_DAYS);
    expect(tourDaySpan(5000)).toBeNull();
  });

  it('модуль чистый', () => {
    const src = readFileSync(join(ROOT, 'lib/planner/tour-span.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

describe('тур занимает свои дни, а платится один раз', () => {
  it('индекс материала и счёт занятых дней — разные числа', () => {
    // Пока это было одно `d`, многодневный тур не мог занять больше одного
    // дня физически.
    expect(ENGINE).toMatch(/let d = 0;\s*\n\s*let used = 0;/);
    expect(ENGINE).toMatch(/while \(used < block\.activeDays/);
    expect(ENGINE).toMatch(/used \+= span;/);
  });

  it('span приходит из длительности тура, а не из константы', () => {
    // Самое важное свойство, и первая редакция сторожа его НЕ держала:
    // мутация `const span = 1` проходила все проверки — цикл оставался
    // правильным по форме и бессмысленным по сути.
    const at = ENGINE.indexOf('const span = ');
    expect(at, 'span не присваивается').toBeGreaterThan(0);
    const before = ENGINE.slice(Math.max(0, at - 400), at);
    expect(before, 'span не выведен из длительности по правилу брони').toContain('tourPlanSpan(realTour.durationHours, realTour.multiDayCount)');
    expect(ENGINE.slice(at, at + 60)).toMatch(/const span = declaredSpan \?\? 1;/);
  });

  it('дни продолжения не повторяют цену', () => {
    const at = ENGINE.indexOf('— день ${extra + 1} из ${span}');
    expect(at, 'дней продолжения нет').toBeGreaterThan(0);
    const block = ENGINE.slice(at, at + 700);
    // Цена многодневного тура — за весь тур. Посчитать её N раз значило бы
    // умножить счёт туристу.
    expect(block).toMatch(/priceFrom: 0, priceTo: 0/);
    // Но тур у дня тот же — иначе смета начнёт считать за него ночь.
    expect(block).toContain('realTour: realTourData');
  });

  it('число дней продолжения ограничено и сроком, и бюджетом зоны', () => {
    const at = ENGINE.indexOf('for (let extra = 1; extra < span');
    expect(at, 'цикла продолжения нет').toBeGreaterThan(0);
    const head = ENGINE.slice(at, at + 200);
    expect(head).toContain('used + extra <= block.activeDays');
    expect(head).toContain('dayNum <= tripDays - departureDays');
  });
});

describe('тур не режется по границе поездки', () => {
  it('не влезающий пропускается целиком', () => {
    // «Три дня из пятидневного тура» — не продукт, его нельзя купить.
    expect(ENGINE).toMatch(/if \(span > block\.activeDays\)/);
    const at = ENGINE.indexOf('if (span > block.activeDays)');
    expect(ENGINE.slice(at, at + 300)).toContain('tooLong.add');
  });

  it('о пропущенном говорится словами, с причиной и выходом', () => {
    const at = ENGINE.indexOf('Не поместились в срок поездки');
    expect(at, 'о пропущенных турах молчит').toBeGreaterThan(0);
    const block = ENGINE.slice(at - 300, at + 500);
    expect(block).toContain("severity: 'important'");
    // Не просто «не вошли», а почему и что делать.
    expect(block).toContain('Добавьте дней');
  });

  it('неизвестная длительность названа отдельно от непоместившихся', () => {
    // Разные беды и разные починки: одну чинит оператор в карточке тура,
    // другую — турист сроком поездки.
    expect(ENGINE).toContain('Длительность не указана у');
    const at = ENGINE.indexOf('Длительность не указана у');
    expect(ENGINE.slice(at - 300, at + 400)).toContain("severity: 'important'");
  });
});

describe('цикл завершается сам', () => {
  it('бесплодные обороты считаются и обрывают цикл', () => {
    // С `for (...; d++)` от зацикливания спасал заголовок. У `while`
    // каждый `continue` без продвижения крутился бы вечно — а `continue`
    // в теле два: несуществующая активность и повторный общий день.
    expect(ENGINE).toMatch(/let barren = 0;/);
    expect(ENGINE).toMatch(/if \(barren >= block\.interests\.length\) break;/);
  });

  it('каждый continue в теле цикла продвигает материал', () => {
    const start = ENGINE.indexOf('while (used < block.activeDays');
    const end = ENGINE.indexOf('prevZone = block.zone;', start);
    const body = ENGINE.slice(start, end);
    const continues = [...body.matchAll(/continue;/g)];
    expect(continues.length, 'continue в цикле не найдено — сломался разбор').toBeGreaterThan(0);
    for (const m of continues) {
      const before = body.slice(Math.max(0, m.index - 120), m.index);
      expect(before, `continue без продвижения: ${before.slice(-60)}`).toMatch(/d\+\+;\s*barren\+\+;/);
    }
  });

  it('успешный оборот обнуляет счётчик бесплодных', () => {
    // Иначе редкая полоса пропусков оборвала бы сборку досрочно.
    expect(ENGINE).toMatch(/barren = 0;/);
  });
});

describe('дни тура в плане — по правилу брони (#2304)', () => {
  // Бронь (lib/bookings/duration) считает длительность сначала по дням
  // словами оператора (`multi_day_count`), потом по часам. План читал только
  // часы: тур «8 дней» с пустыми часами стоял одним днём, а бронь занимала
  // восемь.
  it('дни словами оператора важнее часов', () => {
    expect(tourPlanSpan(null, 8)).toBe(8);
    expect(tourPlanSpan(10, 4)).toBe(4);
    expect(tourPlanSpan(192, 8)).toBe(8);
  });

  it('дней нет — по часам, как раньше', () => {
    expect(tourPlanSpan(120, null)).toBe(5);
    expect(tourPlanSpan(8, null)).toBe(1);
    expect(tourPlanSpan(72, 1)).toBe(3);
  });

  it('ничего не записано — «не знаем»; «1 день» словами — знание', () => {
    expect(tourPlanSpan(null, null)).toBeNull();
    expect(tourPlanSpan(undefined, undefined)).toBeNull();
    expect(tourPlanSpan(0, 0)).toBeNull();
    expect(tourPlanSpan(null, 1)).toBe(1);
  });

  it('нелепое число дней отвергается так же, как нелепые часы', () => {
    expect(tourPlanSpan(null, MAX_TOUR_DAYS)).toBe(MAX_TOUR_DAYS);
    expect(tourPlanSpan(null, 400)).toBeNull();
  });

  it('везде, где план знает длительность, она равна длительности брони', () => {
    const hours = [null, 0, 2.5, 8, 24, 25, 48, 72, 96, 120, 168, 192, 336];
    const days = [null, 0, 1, 2, 3, 4, 5, 7, 8, 12, 14];
    for (const h of hours) {
      for (const m of days) {
        const plan = tourPlanSpan(h, m);
        if (plan === null) continue;
        expect(plan, `часы ${h}, дни ${m}`).toBe(tourDurationDays({ duration_hours: h, multi_day_count: m }));
      }
    }
  });

  it('движок ставит и предрасчёт растяжки блока по тому же правилу', () => {
    expect(ENGINE).toContain('tourPlanSpan(t.durationHours, t.multiDayCount)');
    expect(ENGINE).not.toMatch(/tourDaySpan\((?:t|realTour)\.durationHours\)/);
  });
});
