// @vitest-environment jsdom
/**
 * Соседям по мешу уходит позиция с точностью около километра (скан
 * безопасности 25.11): сосед в меше — любой, кто открыл карту рядом, и точная
 * позиция раз в 10 секунд позволяла вести туриста по маршруту. Точные
 * координаты остаются только в SOS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coarsePosition } from '@/lib/mesh/volcano-mesh';

const SRC = readFileSync(join(process.cwd(), 'lib/mesh/volcano-mesh.ts'), 'utf-8');

describe('coarsePosition', () => {
  it('округляет до сотых градуса и не обещает точности лучше километра', () => {
    expect(coarsePosition({ lat: 53.123456, lng: 158.987654, accuracy: 8, timestamp: 1 }))
      .toEqual({ lat: 53.12, lng: 158.99, accuracy: 1000, timestamp: 1 });
    expect(coarsePosition({ lat: 53, lng: 158, accuracy: 5000, timestamp: 2 })?.accuracy).toBe(5000);
    expect(coarsePosition(undefined)).toBeUndefined();
  });
});

describe('позиция соседям — только огрублённая', () => {
  it('каждая отправка position идёт через coarsePosition', () => {
    const sends = SRC.match(/type: 'position'[^\n]*\n?[^\n]*\n?[^\n]*payload:[^\n]*/g) ?? [];
    const inline = SRC.match(/type: 'position', payload: [^,]+/g) ?? [];
    expect(sends.length + inline.length).toBeGreaterThan(0);
    for (const s of [...sends, ...inline]) expect(s).toMatch(/coarsePosition\(/);
  });

  it('сигналинг подписан ключом потока', () => {
    expect(SRC).toMatch(/JSON\.stringify\(\{ token: this\.signalToken, to, message \}\)/);
    expect(SRC).toMatch(/type === 'session'/);
  });
});
