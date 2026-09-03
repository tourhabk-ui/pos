/**
 * Радар различает вулкан, пожар и сейсмособытие формой, не только цветом.
 *
 * ── Случай 03.09 (вулкан vs сейсмика) ────────────────────────────────────────
 *
 * Владелец: «в радаре нужно отличать вулкан от сейсмособытий». До этого оба
 * рисовались одинаковым кружком, а цвет кодировал только СИЛУ (критично /
 * опасно / внимание), не РОД опасности — различить вулкан и землетрясение
 * рядом на круге можно было только тапом по каждой точке по очереди.
 *
 * ── Случай 03.09 (пожар) ──────────────────────────────────────────────────
 *
 * Владелец: «на радаре есть пожары, отметь их другим значком». Термоточки
 * NASA FIRMS (alert_type 'fire_danger', реальные координаты — не декларация)
 * попадали в общий kind 'report', тот же вид, что у медведя, погоды и
 * камнепада. Третья форма — ромб — досталась только пожару: сейсмика и
 * остальное по-прежнему круг, своей формы у них нет и не появилась.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const LIVE = strip(read('components/safety/LiveStatus.tsx'));
const DATA = strip(read('app/_home/data.ts'));
const at = LIVE.indexOf('export function RadarScope');
const comp = LIVE.slice(at, at + 12000);

describe('форма точки зависит от рода, не только цвет — от силы', () => {
  const markAt = comp.indexOf("h.kind === 'volcano' ?");
  const block = comp.slice(markAt, markAt + 1400);

  it('ветка по kind найдена', () => {
    expect(markAt).toBeGreaterThan(0);
  });

  it('вулкан рисуется треугольником (polygon), не кругом', () => {
    const volcanoBlock = block.slice(0, block.indexOf("h.kind === 'fire'"));
    expect(volcanoBlock).toMatch(/<polygon/);
  });

  it('пожар рисуется отдельным polygon — ромбом, своя ветка от вулкана', () => {
    const fireAt = block.indexOf("h.kind === 'fire'");
    expect(fireAt, 'ветка по пожару не найдена').toBeGreaterThan(0);
    const fireBlock = block.slice(fireAt, fireAt + 500);
    expect(fireBlock).toMatch(/<polygon/);
    // Ромб — четыре угла (в отличие от треугольника вулкана — трёх): в
    // шаблонной строке points четыре пары h.x/h.y.
    const tplAt = fireBlock.indexOf('points={`');
    const tplStr = fireBlock.slice(tplAt, fireBlock.indexOf('`}', tplAt));
    const xCount = (tplStr.match(/h\.x/g) ?? []).length;
    const yCount = (tplStr.match(/h\.y/g) ?? []).length;
    expect(xCount).toBe(4);
    expect(yCount).toBe(4);
  });

  it('всё остальное — по-прежнему круг', () => {
    expect(block).toMatch(/<circle/);
  });

  it('цвет по-прежнему кодирует силу — LEVEL_COLOR используется во всех трёх ветках', () => {
    const matches = block.match(/LEVEL_COLOR\[h\.level\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe('легенда формы — только когда есть что различать', () => {
  const legAt = comp.indexOf('<div className="rshapes">');

  it('строка легенды условна: считает все три рода по отдельности', () => {
    expect(legAt, 'легенда формы не найдена').toBeGreaterThan(0);
    const before = comp.slice(Math.max(0, legAt - 700), legAt);
    expect(before).toMatch(/hasVolcano = placed\.some\(\(h\) => h\.kind === 'volcano'\)/);
    expect(before).toMatch(/hasFire = placed\.some\(\(h\) => h\.kind === 'fire'\)/);
    expect(before).toMatch(/hasOther = placed\.some\(\(h\) => h\.kind !== 'volcano' && h\.kind !== 'fire'\)/);
  });

  it('показывается, только если различимых форм на круге больше одной', () => {
    const before = comp.slice(Math.max(0, legAt - 700), legAt);
    expect(before).toMatch(/\[hasVolcano, hasFire, hasOther\]\.filter\(Boolean\)\.length < 2/);
  });

  it('легенда объясняет все три формы словами', () => {
    const block = comp.slice(legAt, legAt + 1500);
    expect(block).toMatch(/вулкан/);
    expect(block).toMatch(/пожар/);
    expect(block).toMatch(/сейсмика/);
  });
});

describe('данные: пожар — свой kind, не общая свалка "report"', () => {
  it('HazardKind включает fire', () => {
    expect(DATA).toMatch(/export type HazardKind = [^;]*'fire'/);
  });

  it('alert_type с "fire" классифицируется как fire, а не report', () => {
    const at2 = DATA.indexOf("const kind: HazardKind =");
    const block = DATA.slice(at2, at2 + 400);
    expect(block).toMatch(/\/fire\/\.test\(type\) \? 'fire'/);
  });

  it('KIND_LABEL называет пожар пожаром', () => {
    expect(LIVE).toMatch(/fire: 'Пожар'/);
  });
});
