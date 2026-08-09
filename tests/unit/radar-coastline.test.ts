/**
 * Контур берега на радаре безопасности виден и не рисует ложную диагональ.
 *
 * Владелец: «контур где?» — берег был почти прозрачным (strokeOpacity 0.25), а
 * замыкание полигона (Z) тянуло прямую хорду между крайними точками берега через
 * весь скоп — та самая лишняя диагональ. Берег — открытая линия, не блоб.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'components/safety/LiveStatus.tsx'), 'utf-8');

describe('радар: контур берега', () => {
  it('берег — открытая линия: путь НЕ замыкается через Z', () => {
    const coast = src.slice(src.indexOf('const coastSegments'), src.indexOf('const rings'));
    expect(coast).not.toContain("+ ' Z'");
    expect(coast).not.toContain('+ " Z"');
  });

  it('длинные хорды не рисуются: пробел честнее прямой через воду', () => {
    // Узлы отстоят на 50-80 км, и в круге радиусом 200 км прямая между ними
    // режет скоп по диагонали — на экране это читалось как случайные линии
    // (владелец 09.08: «радар сломан»). Звено рисуется, только если прямая —
    // честное приближение берега; остальное остаётся разрывом.
    const coast = src.slice(src.indexOf('const MAX_SEGMENT_KM'), src.indexOf('const rings'));
    expect(coast).toMatch(/MAX_SEGMENT_KM = \d+/);
    expect(coast).toMatch(/gapKm > MAX_SEGMENT_KM/);
    // Разрыв — это НОВЫЙ подпуть с 'M', а не продолжение линии.
    expect(coast).toMatch(/current\.length === 0 \? 'M' : 'L'/);
  });

  it('кольца подписаны расстоянием — единственное, что радар знает точно', () => {
    expect(src).toMatch(/\{Math\.round\(MAX_KM \* k\)\} км/);
  });

  it('пустое состояние не заслоняет центр радара', () => {
    const clean = src.slice(src.indexOf('.kh-live .radar .clean{'), src.indexOf('.kh-live .radar .clean{') + 160);
    expect(clean).not.toMatch(/top:50%/);
  });

  it('контур видимый: без заливки-блоба, заметный штрих', () => {
    const path = src.slice(src.indexOf('d={coastPath}'), src.indexOf('d={coastPath}') + 220);
    expect(path).toContain('fill="none"');
    // штрих ощутимо плотнее прежних 0.25
    expect(path).toMatch(/strokeOpacity="0\.5[0-9]?"/);
  });
});
