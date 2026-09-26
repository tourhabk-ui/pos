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
import { lodgingIncluded } from '@/lib/planner/lodging-included';

const ROOT = process.cwd();
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf8');
const CONSTANTS = readFileSync(join(ROOT, 'lib/planner/constants.ts'), 'utf8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf8');

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

  it('день с включённым проживанием ночь не оплачивает', () => {
    const at = ENGINE.indexOf('let accFrom = 0;');
    expect(at, 'блок сметы ночёвок не нашёлся').toBeGreaterThan(0);
    const block = ENGINE.slice(at, at + 600);
    expect(block).toMatch(/if \(day\.realTour\?\.lodgingIncluded === true\) continue;/);
  });

  it('только true пропускает ночь: «не знаем» платит', () => {
    // Сравнение с `true` строгое намеренно. Истинностная проверка
    // (`if (day.realTour?.lodgingIncluded)`) вела бы себя так же, но
    // молча — и следующая правка легко превратила бы null в «включено».
    const at = ENGINE.indexOf('let accFrom = 0;');
    const block = ENGINE.slice(at, at + 600);
    expect(block).not.toMatch(/if \(day\.realTour\?\.lodgingIncluded\) continue;/);
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
    const at = ENGINE.indexOf("note: 'Однодневная экскурсия, ночёвка в Авачинской зоне'");
    expect(at, 'северная зона не нашлась').toBeGreaterThan(0);
    // С 26.09 правило «где ночуют» живёт одной картой в constants
    // (ZONE_SLEEPS_IN): его же читает подбор настоящего жилья планера
    // (lib/planner/trip-extras). Две копии правила разошлись бы.
    expect(ENGINE.slice(at, at + 260)).toMatch(/sleepsIn: ZONE_SLEEPS_IN\.northern/);
    expect(CONSTANTS).toMatch(/ZONE_SLEEPS_IN[^=]*=\s*\{\s*northern: 'avachinsky'/);
  });

  it('смета читает это поле, а не только приписку', () => {
    // Поле без потребителя — то же объявление в никуда, что и приписка
    // (§10.09): выглядело бы починкой, не будучи ею.
    const at = ENGINE.indexOf('let accFrom = 0;');
    const block = ENGINE.slice(at, at + 700);
    expect(block).toMatch(/const sleepZone = sleepZoneOf\(day\.zone\)/);
    expect(CONSTANTS).toMatch(/return ZONE_SLEEPS_IN\[zone\] \?\? zone/);
    expect(block).toMatch(/const acc = ZONE_ACCOMMODATION\[sleepZone\]/);
  });

  it('зона, где ночуют, платит по своей цене', () => {
    // Иначе правка свелась бы к «взять ноль из другого места».
    const at = ENGINE.indexOf('let accFrom = 0;');
    const block = ENGINE.slice(at, at + 700);
    expect(block).not.toMatch(/ZONE_ACCOMMODATION\[day\.zone\]\.pricePerNight/);
  });
});

describe('завышение не остаётся молчаливым', () => {
  it('неразобранный состав даёт предупреждение', () => {
    expect(ENGINE).toMatch(/const unknownLodging = days\.filter\(d => d\.realTour && d\.realTour\.lodgingIncluded === null\)/);
    const at = ENGINE.indexOf('итог в смете завышен');
    expect(at, 'о завышении не сказано').toBeGreaterThan(0);
    const block = ENGINE.slice(at - 500, at + 200);
    // Не «инфо»: Кузьмич показывает предупреждения severity !== 'info'.
    expect(block).toContain("severity: 'important'");
  });

  it('предупреждение называет направление ошибки, а не просто «уточните»', () => {
    // «Могут быть неточности» ничего не говорит; «итог завышен» говорит,
    // в какую сторону и что с этим делать.
    const at = ENGINE.indexOf('итог в смете завышен');
    expect(ENGINE.slice(at - 300, at + 120)).toContain('уточните у оператора');
  });
});
