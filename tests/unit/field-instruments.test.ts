/**
 * Приборный вид полевого экрана (макеты FCN, дизайн-проход).
 *
 * До этого прохода логика честности была на месте, а вид оставался
 * служебным: тонкий кружок вместо шкалы, мелкая цифра, продублированное
 * название маршрута. Экран, который держат в перчатке и читают боковым
 * зрением, так работать не может — поэтому вид тоже под сторожем.
 *
 * Проверяется не красота, а различимость и однозначность: шкала с
 * оцифровкой, стрелка НА ТОЧКУ (а не на север), крупная главная цифра,
 * непрозрачные приборы, отсутствие дублей.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bearingDeg, formatBearing } from '@/lib/on-route/bearing';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const COMPASS = read('components/field/FieldCompass.tsx');
const DISTANCE = read('components/field/FieldDistance.tsx');
const STRIP = read('components/field/FieldStatusStrip.tsx');
const SCREEN = read('app/planning/_PlanningClient.tsx');

describe('азимут на точку считается один раз и по сфере', () => {
  it('строго на север даёт 0°, на восток — 90°', () => {
    expect(Math.round(bearingDeg({ lat: 53, lng: 158 }, { lat: 54, lng: 158 }))).toBe(0);
    expect(Math.round(bearingDeg({ lat: 53, lng: 158 }, { lat: 53, lng: 159 }))).toBe(90);
    expect(Math.round(bearingDeg({ lat: 53, lng: 158 }, { lat: 52, lng: 158 }))).toBe(180);
    expect(Math.round(bearingDeg({ lat: 53, lng: 158 }, { lat: 53, lng: 157 }))).toBe(270);
  });

  it('сходимость меридианов учтена — не плоская формула', () => {
    // На широте 53° градус долготы короче градуса широты почти вдвое
    // (cos 53° ≈ 0.6). Смещение «+0.1° на север и +0.1° на восток» — это
    // 11.1 км против 6.7 км, то есть азимут около 31°. Наивная формула по
    // сырым градусам вернула бы ровно 45° и увела бы в тумане на 14°.
    const b = bearingDeg({ lat: 53, lng: 158 }, { lat: 53.1, lng: 158.1 });
    expect(b).toBeLessThan(40);
    expect(b).toBeGreaterThan(25);
  });

  it('формат прибора — три знака с нулями', () => {
    expect(formatBearing(42)).toBe('042°');
    expect(formatBearing(7.4)).toBe('007°');
    expect(formatBearing(359.6)).toBe('000°');
  });

  it('без своего положения азимута нет', () => {
    expect(SCREEN).toMatch(/if \(!coords \|\| !nextWp[\s\S]{0,120}return null/);
  });
});

describe('компас — шкала, а не кружок', () => {
  it('засечки через 5°, оцифровка через 30°', () => {
    expect(COMPASS).toMatch(/a \+= 5/);
    expect(COMPASS).toMatch(/a % 30 === 0/);
    expect(COMPASS).toMatch(/DEGREE_LABELS = \[30, 60, 120, 150, 210, 240, 300, 330\]/);
  });

  it('стороны света русские и крупные', () => {
    for (const l of ['С', 'В', 'Ю', 'З']) expect(COMPASS).toContain(`'${l}'`);
    expect(COMPASS).toMatch(/size \* 0\.1/); // кегль букв — доля прибора
  });

  it('стрелка показывает НА ТОЧКУ, а не на север', () => {
    expect(COMPASS).toMatch(/targetBearing - heading/);
    expect(COMPASS).toMatch(/На точку:/);
  });

  it('прибор непрозрачный — стекла на приборах нет', () => {
    expect(COMPASS).not.toMatch(/backdrop-filter|backdrop-blur|fx-glass/);
  });
});

describe('главная цифра различима без фокусировки', () => {
  it('кегль числа задан крупным и адаптивным', () => {
    // 02.09 (форма листа, скрин владельца 08:18): 92px забирали четверть
    // листа под одно число; 64 читается на ходу так же. Нижняя граница
    // держит крупность, верхняя — место под чипы и действия.
    const m = DISTANCE.match(/fontSize: 'clamp\((\d+)px, (\d+)vw, (\d+)px\)'/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(40);
    expect(Number(m![3])).toBeGreaterThanOrEqual(56);
    expect(Number(m![3])).toBeLessThanOrEqual(72);
  });

  it('единица измерения набрана отдельно от числа', () => {
    expect(DISTANCE).toMatch(/const value =/);
    expect(DISTANCE).toMatch(/const unit =/);
  });

  it('чипы контекста рисуются только при наличии данных', () => {
    expect(DISTANCE).toMatch(/p\.pointName \|\| p\.etaLabel \|\| p\.ascentLabel/);
    expect(DISTANCE).toMatch(/p\.etaLabel && \(/);
    expect(DISTANCE).toMatch(/p\.ascentLabel && \(/);
  });
});

describe('приборная строка вверху и отсутствие дублей', () => {
  it('строка несёт качество фикса, маршрут и счёт точек', () => {
    expect(SCREEN).toMatch(/<FieldStatusStrip/);
    expect(STRIP).toMatch(/fixLabel/);
    expect(STRIP).toMatch(/checkpoint/);
  });

  it('вторая строка говорит о состоянии данных', () => {
    expect(SCREEN).toMatch(/Карта сохранена/);
    expect(SCREEN).toMatch(/Карта не сохранена — в поле не откроется/);
  });

  it('название маршрута и счёт точек не продублированы у цифры', () => {
    const code = SCREEN.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    // Прежний дубль: заголовок маршрута и «Точка N из M» рядом с компасом.
    expect(code).not.toMatch(/Точка \{Math\.min\(currentWpIdx \+ 1/);
  });

  it('старого декоративного компаса в экране не осталось', () => {
    expect(SCREEN).not.toMatch(/function CompassDisplay/);
  });
});
