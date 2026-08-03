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
    // Ищем конкретно построение coastPath; в нём не должно быть склейки " Z".
    const coast = src.slice(src.indexOf('const coastPath'), src.indexOf('const rings'));
    expect(coast).not.toContain("+ ' Z'");
    expect(coast).not.toContain('+ " Z"');
  });

  it('контур видимый: без заливки-блоба, заметный штрих', () => {
    const path = src.slice(src.indexOf('d={coastPath}'), src.indexOf('d={coastPath}') + 220);
    expect(path).toContain('fill="none"');
    // штрих ощутимо плотнее прежних 0.25
    expect(path).toMatch(/strokeOpacity="0\.5[0-9]?"/);
  });
});
