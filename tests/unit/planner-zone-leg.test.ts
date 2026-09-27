/**
 * Сторож: поездка в дальнюю зону решается связкой, а не одним днём.
 *
 * ── Что нашлось 27.09 (владелец: «planner как-то очень не продуманная логика») ─
 *
 * Прогон живого движка на четырёх длительностях дал три невыполнимых плана, и
 * у первых двух корень один — проверка «хватает ли дней» стояла ПОСЛЕ того, как
 * день переезда уже попал в план, а отката не было:
 *
 *   • 5-6 дней: в плане день «Переезд: Авачинская → Западная зона» за
 *     5 000-8 000 ₽ и ни одного дня в Западной зоне. Человек платит за дорогу и
 *     теряет день, чтобы попасть туда, где по плану ничего не происходит;
 *   • 7 дней: переезд туда (5-й день), рыбалка там (6-й), вылет из
 *     Петропавловска (7-й). Дня на возвращение нет, цена его не посчитана;
 *   • 7 дней: день вылета стоял ШЕСТЫМ из семи — он брал номер из счётчика
 *     заполненных дней, а не дату отъезда. Последняя строка плана читается как
 *     день рейса, и она указывала не на тот день.
 *
 * Сторож держит правило (чистые функции), его подключение в движке (форма
 * кода) и три следствия, каждое из которых чинилось отдельно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_DAYS_IN_ZONE,
  zoneLegCost,
  legFits,
  legShortfallMessage,
} from '@/lib/planner/zone-leg';

const ENGINE = readFileSync(join(process.cwd(), 'lib/planner/engine.ts'), 'utf-8');
/** Код без комментариев: в них старая форма как раз описана — и должна быть. */
const CODE = ENGINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('во сколько дней встаёт заход в зону', () => {
  it('Авачинская → Западная и обратно: переезд, день на месте, возвращение', () => {
    const cost = zoneLegCost('avachinsky', 'western');
    expect(cost.reachable).toBe(true);
    expect(cost.travelIn).toBe(1);
    expect(cost.stay).toBe(MIN_DAYS_IN_ZONE);
    expect(cost.travelBack).toBe(1);
    expect(cost.total).toBe(3);
  });

  it('своя зона не стоит ни дороги, ни возвращения', () => {
    const cost = zoneLegCost('avachinsky', 'avachinsky');
    expect(cost.total).toBe(MIN_DAYS_IN_ZONE);
    expect(cost.travelIn).toBe(0);
    expect(cost.travelBack).toBe(0);
  });

  it('вертолётное плечо без отдельного дня переезда дней на дорогу не просит', () => {
    // Авачинская → Северная: needsTravelDay = false у ребра туда и обратно.
    const cost = zoneLegCost('avachinsky', 'northern');
    expect(cost.travelIn).toBe(0);
    expect(cost.travelBack).toBe(0);
    expect(cost.total).toBe(MIN_DAYS_IN_ZONE);
  });

  it('день на месте нельзя сократить до нуля: ехать семь часов незачем', () => {
    expect(zoneLegCost('avachinsky', 'western', 0).stay).toBe(MIN_DAYS_IN_ZONE);
    expect(zoneLegCost('avachinsky', 'western', 3).total).toBe(5);
  });

  it('нет ребра в графе — зона недостижима, и это не «ноль дней»', () => {
    // Такой пары в графе нет: проверяем, что недостижимость не превращается в
    // бесплатную поездку.
    const cost = zoneLegCost('western', 'western');
    expect(cost.reachable).toBe(true);
    const broken = zoneLegCost('avachinsky', 'nowhere' as never);
    expect(broken.reachable).toBe(false);
    expect(legFits(broken, 99)).toBe(false);
  });
});

describe('влезает ли связка в остаток дней', () => {
  it('три дня связки в двух свободных не влезают', () => {
    expect(legFits(zoneLegCost('avachinsky', 'western'), 2)).toBe(false);
  });

  it('ровно три свободных — влезает', () => {
    expect(legFits(zoneLegCost('avachinsky', 'western'), 3)).toBe(true);
  });

  it('недостижимая зона не влезает ни при каком запасе', () => {
    expect(legFits({ travelIn: 0, stay: 1, travelBack: 0, total: 0, reachable: false }, 100)).toBe(false);
  });
});

describe('причина отказа называется числом, а не «не хватило»', () => {
  it('в тексте есть нужное и имеющееся', () => {
    const msg = legShortfallMessage('western', zoneLegCost('avachinsky', 'western'), 2, ['рыбалка']);
    expect(msg).toContain('рыбалка');
    expect(msg).toContain('Западная');
    expect(msg).toMatch(/нужно 3/);
    expect(msg).toMatch(/осталось 2/);
    // Совет должен быть исполнимым: добавить дни или выбрать ближе.
    expect(msg).toMatch(/Добавьте дни|выберите/);
  });

  it('недостижимая зона объясняется отдельно и не врёт про дни', () => {
    const msg = legShortfallMessage('northern', { travelIn: 0, stay: 1, travelBack: 0, total: 0, reachable: false }, 5, []);
    expect(msg).toMatch(/дороги отсюда нет/);
    expect(msg).not.toMatch(/нужно 0/);
  });
});

describe('движок спрашивает правило ДО того, как ставит день переезда', () => {
  it('связка считается перед push дня переезда', () => {
    const legIdx = CODE.indexOf('legFits(cost, daysLeft)');
    const pushIdx = CODE.indexOf("type: 'travel', zone: prevZone");
    expect(legIdx, 'движок не спрашивает правило связки').toBeGreaterThan(0);
    expect(pushIdx).toBeGreaterThan(0);
    expect(legIdx, 'правило спрашивается после того, как день переезда уже в плане').toBeLessThan(pushIdx);
  });

  it('после push дня переезда нет выхода из цикла без отката', () => {
    // Ровно эта пара строк и давала «переезд в никуда»: день уже добавлен, а
    // цикл прерван до того, как в зоне появился хоть один день.
    const after = CODE.slice(CODE.indexOf("title: `Переезд: ${ZONE_NAMES[prevZone]}"));
    const nextHundred = after.slice(0, 900);
    expect(nextHundred, 'break сразу после дня переезда вернулся').not.toMatch(/break;/);
  });

  it('пропущенная зона попадает в список с причиной, а не исчезает молча', () => {
    expect(CODE).toMatch(/skippedLegs\.push/);
    expect(CODE).toMatch(/legShortfallMessage\(/);
  });

  it('план, кончившийся в чужой зоне без возвращения, говорит об этом критически', () => {
    expect(CODE).toMatch(/returnLegMissing/);
    const idx = CODE.indexOf('returnLegMissing) {');
    expect(idx).toBeGreaterThan(0);
    expect(CODE.slice(idx, idx + 400)).toMatch(/critical/);
  });

  it('день вылета берёт ДАТУ отъезда, а не счётчик заполненных дней', () => {
    expect(CODE).toMatch(/day: tripDays, type: 'departure'/);
    expect(CODE, 'день вылета снова съезжает вперёд на недобор').not.toMatch(/day: dayNum, type: 'departure'/);
  });
});

describe('требования зон считаются по дням плана', () => {
  it('разрешения перебираются по зонам плана, а не по кандидатам', () => {
    expect(CODE).toMatch(/for \(const zone of plannedZones\)/);
    expect(CODE, 'критичные разрешения снова берутся из зон-кандидатов').not.toMatch(/for \(const zr of zones\) \{\s*const permits/);
  });

  it('удалённость — тоже по зонам плана', () => {
    expect(CODE).toMatch(/remoteZones = \[\.\.\.plannedZones\]/);
  });

  it('требования зон вне плана остаются справкой без веса critical', () => {
    const idx = CODE.indexOf('extraPermits.length > 0');
    expect(idx).toBeGreaterThan(0);
    const block = CODE.slice(idx, idx + 400);
    expect(block).toMatch(/severity: 'info'/);
    expect(block).not.toMatch(/critical/);
  });

  it('дни собираются до предупреждений — иначе зон плана ещё не существует', () => {
    const daysIdx = CODE.indexOf('await generateDayPlans(');
    const warnIdx = CODE.indexOf('collectWarnings(profile, zones, tripDays');
    expect(daysIdx).toBeGreaterThan(0);
    expect(warnIdx).toBeGreaterThan(0);
    expect(daysIdx, 'предупреждения считаются раньше дней плана').toBeLessThan(warnIdx);
  });
});
