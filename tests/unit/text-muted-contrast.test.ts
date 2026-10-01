/**
 * Подписи читаются: --text-muted держит WCAG AA (4,5:1) к фону страницы и к
 * карточке в обеих темах (аудит vedarai.ru 01.10, решение владельца).
 *
 * Прежние #9A9590 (светлая) и #484F58 (тёмная) давали 2,6:1 и 2,3:1 — axe
 * находил нарушение контраста на всех восьми проверенных типах страниц.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS = readFileSync('app/globals.css', 'utf-8');

function block(selectorStart: string): string {
  const i = CSS.indexOf(selectorStart);
  expect(i, selectorStart).toBeGreaterThanOrEqual(0);
  return CSS.slice(i, CSS.indexOf('}', i));
}
function token(b: string, name: string): string {
  const m = b.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
  expect(m, name).not.toBeNull();
  return m![1];
}
function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('--text-muted держит AA', () => {
  for (const sel of [':root[data-theme="dark"]', ':root[data-theme="light"]', ':root:not([data-theme])']) {
    it(sel, () => {
      const b = block(sel);
      const muted = token(b, 'text-muted');
      expect(contrast(muted, token(b, 'bg-primary'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(muted, token(b, 'bg-card'))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('страница ошибки повторяет светлый токен', () => {
    const light = token(block(':root[data-theme="light"]'), 'text-muted');
    expect(readFileSync('app/global-error.tsx', 'utf-8')).toContain(`--text-muted: ${light};`);
  });
});
