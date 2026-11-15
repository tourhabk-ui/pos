/**
 * Сторож: ночь, уже включённую в тур, смета не считает второй раз.
 *
 * ── Замер с прода 20.09 (MCP `get_tour_details`) ─────────────────────────
 *
 * Тур ID9 «Многодневный летний тур (5 дней)» оператора «Камчатская рыбалка»,
 * 140 000 ₽. В составе прямым текстом: **«Проживание на базе 5 ночей»**, и
 * в описании — «База — собственный двухэтажный корпус с кухней-столовой,
 * душем и номерами на втором этаже».
 *
 * А `calculatePriceBreakdown` прибавлял цену ночи за КАЖДЫЙ не-отъездный
 * день безусловно, не глядя на состав тура. Западная зона при `comfort` —
 * 20 000 ₽/ночь: семидневный план с этим туром показывал бы ещё
 * 96 000–160 000 ₽ «проживания», которого турист не платит.
 *
 * Ошибка шла В СТОРОНУ ЗАВЫШЕНИЯ, и это не безобидная осторожность: по
 * завышенной смете отказываются от поездки, а выглядит она точной.
 *
 * С 14.11 (слово владельца «5 -1») цены ночи по зоне в смете нет вовсе:
 * строка проживания называет число ночей и «цену называет хозяин жилья».
 * Правило ночей осталось: лишняя ночь в строке зовёт искать жильё, которое
 * уже в туре. Сторож считает ночи строк, а не суммы.
 *
 * ── Почему три исхода ────────────────────────────────────────────────────
 *
 * Состав тура — текст, написанный человеком. «Не разобрали» обязано
 * отличаться от «не включено»: первое считает ночь И ГОВОРИТ об этом,
 * второе считает молча и правильно. Свести их значило бы либо занижать счёт
 * на догадке, либо завышать молча (§4.0).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lodgingIncluded, nightLodgingIncluded } from '@/lib/planner/lodging-included';
import { estimateGroup, type EstimateDay } from '@/lib/planner/estimate';
import { nightZoneOf } from '@/lib/planner/constants';

/** День плана для сметы: переезд несёт зону, откуда едут, — как у движка. */
const planDay = (day: number, type: EstimateDay['type'], zone: EstimateDay['zone'], extra: Partial<EstimateDay> = {}): EstimateDay => ({
  day, type, zone, title: `День ${day}`, priceFrom: 0, priceTo: 0, ...extra,
});
const lodgingLines = (days: EstimateDay[], people = 1) =>
  estimateGroup(days, { adults: people, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' }).lines
    .filter((l) => l.kind === 'lodging');
/** Ночи в строках проживания по зоне — число из «N ночей — …». */
const lodgingNights = (days: EstimateDay[], people = 1): number =>
  lodgingLines(days, people).reduce((n, l) => n + Number(/^(\d+) ноч/.exec(l.basis)?.[1] ?? NaN), 0);

const ROOT = process.cwd();
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf8');
/** Смета с 09.10 живёт отдельно от движка (#2304): её считает и браузер. */
const ESTIMATE = readFileSync(join(ROOT, 'lib/planner/estimate.ts'), 'utf8');
const CONSTANTS = readFileSync(join(ROOT, 'lib/planner/constants.ts'), 'utf8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf8');

/**
 * Тело подсчёта ночёвок — от объявления счётчиков до конца цикла, а не окно в
 * 700 символов от первой строки.
 *
 * Окно ломается от любого добавленного комментария: 27.09 правка «у последнего
 * дня поездки ночи нет» вытеснила проверяемую строку за границу, и тест
 * покраснел на неизменном поведении. Проверяем СМЫСЛ, а не расстояние в
 * байтах.
 */
function lodgingBlock(): string {
  // С 09.10 правило ночи — одна функция `nightOf` в смете (#2304).
  const from = ESTIMATE.indexOf('function nightOf(');
  const to = ESTIMATE.indexOf('// ── Цены туров на человека');
  if (from < 0 || to <= from) throw new Error('правило ночи не найдено в смете');
  return ESTIMATE.slice(from, to);
}

describe('разбор состава тура', () => {
  it('настоящая строка с прода распознаётся', () => {
    // Дословно из ответа ID9 — на выдуманной строке сторож не значил бы ничего.
    expect(lodgingIncluded([
      'Проживание на базе 5 ночей',
      'Летний комплект снаряжения',
      'Лодка с мотором',
      'Сопровождение гида',
    ])).toBe(true);
  });

  it('состав без ночлега — это «не включено», а не «не знаем»', () => {
    expect(lodgingIncluded(['Сопровождение гида', 'Обед на маршруте'])).toBe(false);
  });

  it('состава нет — «не знаем», и это отдельный исход', () => {
    expect(lodgingIncluded(null)).toBeNull();
    expect(lodgingIncluded([])).toBeNull();
    // Массив из пустых строк — тоже нечем судить.
    expect(lodgingIncluded(['', '  '])).toBeNull();
  });

  it('узнаёт разные слова ночлега', () => {
    for (const line of ['Ночлег в палатке', 'Размещение в гостинице', 'Ночёвка на кордоне', 'ночевка в домике']) {
      expect(lodgingIncluded([line]), line).toBe(true);
    }
  });

  it('не принимает за ночлег то, что им не является', () => {
    // Соблазн добавить «номер», «база», «корпус» велик — и каждое из них
    // значит ночлег далеко не всегда. Лишнее слово здесь не расширяет
    // распознавание, а ЗАНИЖАЕТ счёт туристу.
    for (const line of ['Номер телефона гида', 'Трансфер от базы отдыха', 'Спасжилеты на борту']) {
      expect(lodgingIncluded([line]), line).toBe(false);
    }
  });

  it('модуль чистый — его можно звать откуда угодно', () => {
    const src = readFileSync(join(ROOT, 'lib/planner/lodging-included.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

describe('смета не платит за ночь дважды', () => {
  it('состав тура берётся из БД, иначе судить нечем', () => {
    // Признак без источника — объявление в никуда (§10.09).
    expect(DATA).toMatch(/ot\.included,/);
    expect(DATA).toMatch(/included: Array\.isArray\(r\.included\) \? r\.included : null/);
  });

  it('ночь внутри тура с проживанием не оплачивается, ночь после его последнего дня — оплачивается (Б32)', () => {
    // Тур на 3 дня (дни 2–4) с проживанием: покрывает 2 ночи — после дней 2 и 3.
    // Ночь после дня 4 (последний день тура) — уже не его, она оплачивается.
    const t = { tourId: 't', priceUnit: 'per_person', lodgingIncluded: true as const };
    const days = [
      planDay(1, 'arrival', 'western'),
      planDay(2, 'activity', 'western', { realPrice: 50000, realTour: t }),
      planDay(3, 'activity', 'western', { realTour: t }),
      planDay(4, 'activity', 'western', { realTour: t }),
      planDay(5, 'rest', 'western'),
      planDay(6, 'departure', 'western'),
    ];
    // Ночи после дней 1, 4, 5 — три; после 2 и 3 — тур.
    expect(lodgingNights(days)).toBe(3);
    expect(lodgingNights([
      planDay(1, 'arrival', 'western'), planDay(2, 'rest', 'western'), planDay(3, 'rest', 'western'),
      planDay(4, 'departure', 'western'),
    ])).toBe(3);
    // Флаг ночи: внутри тура — true, последний день тура — false, без тура — как есть.
    expect(nightLodgingIncluded(days[1]!, days[2])).toBe(true);
    expect(nightLodgingIncluded(days[3]!, days[4])).toBe(false);
    expect(nightLodgingIncluded({ realTour: { tourId: 'u', lodgingIncluded: null } }, undefined)).toBeNull();
    // Тот же тур вторым бронированием подряд (у первого дня новой брони есть цена) — ночь между ними не покрыта.
    expect(nightLodgingIncluded(days[3]!, { realTour: t, realPrice: 50000 })).toBe(false);
  });

  it('только true пропускает ночь: «не знаем» платит', () => {
    // Сравнение с `true` строгое намеренно. Истинностная проверка
    // (`if (day.realTour?.lodgingIncluded)`) вела бы себя так же, но
    // молча — и следующая правка легко превратила бы null в «включено».
    const block = lodgingBlock();
    expect(block).not.toMatch(/if \(day\.realTour\?\.lodgingIncluded\) (continue|return null);/);
  });

  it('все ветки правила ночи разом: ночи — по зоне, где ночуют, суммы у строки нет', () => {
    // Переезд, северный день, тур с ночлегом и тур без разбора состава.
    // Северный день ночует в Авачинской зоне, переезд — там, куда приехали,
    // последняя ночь тура с ночлегом — уже не его (Б32), тур без разбора
    // состава — ночь стоит.
    const days = [
      planDay(1, 'arrival', 'avachinsky'),
      planDay(2, 'activity', 'northern'),
      planDay(3, 'travel', 'avachinsky', { priceFrom: 5000, priceTo: 8000 }),
      planDay(4, 'activity', 'western', { realPrice: 50000, realTour: { tourId: 't', priceUnit: 'per_person', lodgingIncluded: true } }),
      planDay(5, 'activity', 'western', { realPrice: 9000, realTour: { tourId: 'u', priceUnit: 'per_person', lodgingIncluded: null } }),
      planDay(6, 'departure', 'avachinsky'),
    ];
    expect(lodgingLines(days, 3).map((l) => [l.label, l.basis, l.total])).toEqual([
      ['Проживание в Авачинской зоне', '2 ночи — цену называет хозяин жилья', null],
      ['Проживание в Западной зоне', '3 ночи — цену называет хозяин жилья', null],
    ]);
  });

  it('признак доезжает до дня плана', () => {
    expect(ENGINE).toMatch(/lodgingIncluded: boolean \| null;/);
    expect(ENGINE).toMatch(/lodgingIncluded: lodgingIncluded\(realTour\.included\)/);
  });
});

describe('ночь считается там, где её проводят', () => {
  it('у северной зоны ночёвка отнесена к Авачинской', () => {
    // Было: pricePerNight [0,0,0] с припиской «ночёвка в Авачинской зоне».
    // Факт стоял прозой, код читал из него только ноль — и ночь, которую
    // человек проводит в Петропавловске, не считалась НИГДЕ. Ошибка в
    // обратную сторону от двойного счёта, причина та же: о ночёвке судили
    // не по данным.
    // С 26.09 правило «где ночуют» живёт одной картой в constants
    // (ZONE_SLEEPS_IN): его же читает подбор настоящего жилья планера
    // (lib/planner/trip-extras). Две копии правила разошлись бы.
    expect(nightZoneOf({ type: 'activity', zone: 'northern' }, undefined)).toBe('avachinsky');
    expect(CONSTANTS).toMatch(/ZONE_SLEEPS_IN[^=]*=\s*\{\s*northern: 'avachinsky'/);
  });

  it('смета читает это поле, а не только приписку', () => {
    // Поле без потребителя — то же объявление в никуда, что и приписка
    // (§10.09): выглядело бы починкой, не будучи ею. Ночь северного дня —
    // в Авачинской зоне, а не нигде.
    const days = [planDay(1, 'arrival', 'avachinsky'), planDay(2, 'activity', 'northern'), planDay(3, 'departure', 'avachinsky')];
    const lines = estimateGroup(days, { adults: 1, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' }).lines;
    expect(lines.find((l) => l.label === 'Проживание в Авачинской зоне')).toMatchObject({ basis: '2 ночи — цену называет хозяин жилья', total: null });
    expect(lines.some((l) => /Северной зоне/.test(l.label))).toBe(false);
  });

  it('цены ночи по зоне в смете нет: таблицы средних цен больше нет (14.11, «5 -1»)', () => {
    // До 14.11 ночь стоила «по зоне и уровню» из констант — числа без
    // источника. Возврат таблицы краснеет здесь и в planner-no-unsourced-prices.
    expect(ESTIMATE).not.toMatch(/ZONE_ACCOMMODATION|pricePerNight/);
  });
});

describe('лишняя ночь в смете не остаётся молчаливой', () => {
  it('неразобранный состав даёт предупреждение', () => {
    // Что предупреждение есть, считает туры, а не их дни, и стоит в «Важно», —
    // сценарий на настоящем движке, tests/unit/planner-scenarios.test.ts.
    const at = ENGINE.indexOf('искать его на эти ночи не нужно');
    expect(at, 'о ночах тура без состава не сказано').toBeGreaterThan(0);
    const block = ENGINE.slice(at - 500, at + 200);
    // Не «инфо»: Кузьмич показывает предупреждения severity !== 'info'.
    expect(block).toContain("severity: 'important'");
  });

  it('предупреждение говорит, что делать, а не просто «уточните»', () => {
    // «Могут быть неточности» ничего не говорит; «если жильё уже в туре,
    // искать его не нужно» говорит, в какую сторону ошибка и что с ней делать.
    const at = ENGINE.indexOf('искать его на эти ночи не нужно');
    expect(ENGINE.slice(at - 300, at + 120)).toContain('уточните у оператора');
  });
});
