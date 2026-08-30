/**
 * Компас поля — честность и UX (решение владельца 21.08).
 *
 * Четыре черты, которые нельзя потерять правкой:
 *  1. Неподтверждённая стрелка НЕ рисуется — раньше серая стрелка в
 *     абсолютном угле выглядела как живая (прозрачность на солнце не
 *     читается), и человек шёл за ней. Азимут без стрелки говорит число.
 *  2. Курс несёт родословную: «магнитный датчик» или «по движению GPS» —
 *     словами, как род линии на карте (§12).
 *  3. Курс по движению берётся только на ходу и только конечный.
 *  4. Лекарство на приборе: одна кнопка «Включить компас», в строке
 *     статуса второй кнопки того же действия нет (урок SOS #887).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const compassSrc = readFileSync(
  join(process.cwd(), 'components/field/FieldCompass.tsx'), 'utf-8',
);
const clientSrc = readFileSync(
  join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8',
);

describe('FieldCompass — стрелка только живая', () => {
  it('угол стрелки существует только при подтверждённом азимуте', () => {
    expect(compassSrc).toMatch(/needleAngle = trusted && targetBearing !== null/);
  });

  it('приглушённой стрелки-призрака больше нет', () => {
    expect(compassSrc).not.toMatch(/opacity=\{trusted \? 1 : 0\.3/);
  });

  it('источник курса назван словами', () => {
    expect(compassSrc).toContain('курс — по движению GPS');
    expect(compassSrc).toContain('азимут — магнитный датчик');
    expect(compassSrc).toContain('стрелка скрыта: азимут не подтверждён');
  });
});

describe('полевой экран — курс по движению и одна кнопка', () => {
  it('курс движения берётся только на ходу (порог скорости) и только конечный', () => {
    expect(clientSrc).toMatch(/spd >= 1/);
    expect(clientSrc).toMatch(/Number\.isFinite\(crs\)/);
  });

  it('свежесть курса судится, устаревший не выдаётся за живой', () => {
    expect(clientSrc).toMatch(/nowTick - gpsCourse\.t < 8000/);
  });

  it('кнопка включения — на приборе, и она одна', () => {
    const matches = clientSrc.match(/Включить компас|>\s*Включить\s*</g) ?? [];
    expect(matches).toHaveLength(1);
    expect(clientSrc).toContain('Включить компас');
  });

  it('компас — плавающий инструмент над картой (редизайн 29.08, Шаг 3), не строка в столбце с order-хаком', () => {
    // CSS order-свап (владелец 21.08) снят: компас и геройская цифра
    // больше не делят одно место — у компаса своё постоянное, всегда
    // видное. Хак-строки в источнике быть не должно вовсе.
    expect(clientSrc).not.toMatch(/order: figuresLive/);
    // Плавающий бейдж — fixed-контейнер поверх карты, не в обычном потоке.
    expect(clientSrc).toMatch(/fixed top-28 right-3 z-30/);
  });

  it('компас в бейдже — компактный размер, не дефолтный герой-масштаб (300)', () => {
    // size=300 — дефолт FieldCompass, рассчитанный на центр колонки
    // (прежнее место). В бейдже нужен масштаб поменьше, иначе прибор
    // перекрывает половину экрана поверх карты.
    expect(clientSrc).toMatch(/<FieldCompass[^>]*size=\{130\}/);
  });
});
