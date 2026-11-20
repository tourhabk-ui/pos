/**
 * Футер (только на компьютере) красит текст токенами, а не палитрой Tailwind
 * (#3564 п.6, PageSpeed 20.11: доступность на компьютере 97 при 100 на
 * телефоне).
 *
 * Разница была в футере: ссылка «SOS» стояла `text-red-500`, а это #EF4444 на
 * #F5F5F5 — 3,45:1 при норме AA 4,5. Токен `--danger` держит AA в обеих
 * темах (`text-muted-contrast.test.ts`). Сторож рендерит футер и смотрит
 * классы того, что видит человек.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { Footer } from '@/components/layout/Footer';

/** Цвета палитры Tailwind (`text-red-500`, `hover:text-red-400`…) — мимо токенов. */
const PALETTE_COLOR = /(?:^|\s|:)(?:text|bg|border)-(?:red|orange|amber|yellow|green|emerald|blue|sky|gray|slate|zinc|neutral|stone)-\d{2,3}\b/;

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('футер: цвета текста — токены', () => {
  it('ссылка SOS ведёт на /sos и окрашена токеном опасности', () => {
    render(<Footer />);
    const sos = screen.getByRole('link', { name: 'SOS' });
    expect(sos.getAttribute('href')).toBe('/sos');
    expect(sos.className).toContain('text-[var(--danger)]');
  });

  it('ни у одного элемента футера нет цвета палитры Tailwind', () => {
    const { container } = render(<Footer />);
    const offenders = [...container.querySelectorAll<HTMLElement>('[class]')]
      .filter((el) => PALETTE_COLOR.test(el.getAttribute('class') ?? ''))
      .map((el) => `${el.tagName.toLowerCase()} «${el.textContent?.trim().slice(0, 30)}»: ${el.getAttribute('class')}`);
    expect(offenders).toEqual([]);
  });

  it('светлый --danger на фоне футера держит AA, прежний red-500 — нет', () => {
    const css = readFileSync('app/globals.css', 'utf-8');
    const i = css.indexOf(':root[data-theme="light"]');
    const b = css.slice(i, css.indexOf('}', i));
    const tok = (n: string) => b.match(new RegExp(`--${n}:\\s*(#[0-9A-Fa-f]{6})`))![1]!;
    expect(contrast(tok('danger'), tok('bg-primary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#EF4444', tok('bg-primary'))).toBeLessThan(4.5);
  });
});
