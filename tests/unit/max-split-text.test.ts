/**
 * Длинный ответ в MAX — частями (#3199, K8). Короткий текст не трогается:
 * разбор экранирует голый `<`, и короткие ответы менять незачем.
 */
import { describe, it, expect } from 'vitest';
import { MAX_TEXT_LIMIT, splitMaxText } from '@/lib/max/split-text';

describe('splitMaxText', () => {
  it('короткий текст — одной частью и байт в байт, даже с голым «<»', () => {
    const t = 'Высота 2 < 3 км, <b>важно</b>';
    expect(splitMaxText(t)).toEqual({ parts: [t], droppedChars: 0 });
  });

  it('длинный — части в пределе, теги не рвутся, конец на месте', () => {
    const para = 'слово '.repeat(150);
    const t = Array.from({ length: 6 }, (_, i) => `<b>Раздел ${i}</b>\n${para}`).join('\n\n') + '\n\nКОНЕЦ';
    expect(t.length).toBeGreaterThan(MAX_TEXT_LIMIT);
    const { parts, droppedChars } = splitMaxText(t);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(droppedChars).toBe(0);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(MAX_TEXT_LIMIT);
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length);
    }
    expect(parts.at(-1)).toContain('КОНЕЦ');
  });

  it('предел MAX — 4000', () => {
    expect(MAX_TEXT_LIMIT).toBe(4000);
  });
});
