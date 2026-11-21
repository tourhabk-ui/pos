// @vitest-environment jsdom
/**
 * «Статус мест» на десктопе читается поверх снимка (перенесено из #3294).
 *
 * Строка свежести берёт цвет --glass-fg-muted, а он задан только внутри
 * .fx-glass (app/globals.css). Голым текстом поверх тёмной воды снимка
 * строка читалась тёмным по тёмному (просмотр прода 12.11, 1440 px). Теперь
 * герой ставит её в стеклянную плашку, как приборы над ней.
 *
 * Сторож — рендер героя: строка свежести лежит внутри .fx-glass.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { DeskHero } from '@/components/homepage/desk/DeskHero';
import type { DeskBrief } from '@/lib/home/desk-brief';

const BRIEF: DeskBrief = {
  weekdayLabel: 'суббота, 21 ноября',
  svodka: null,
  changes: null,
  lastIngestAt: null,
  safetyTrusted: false,
  statusUpdatedAt: '2026-11-21T09:57:00Z',
  serverNow: '2026-11-21T10:00:00Z',
};

describe('герой главной: «Статус мест» в стеклянной плашке', () => {
  it('строка свежести — внутри .fx-glass, где задан её цвет', () => {
    const { container } = render(<DeskHero brief={BRIEF} />);
    const line = container.querySelector('[data-desk-freshness]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toMatch(/Статус мест/);
    expect(line!.closest('.fx-glass')).not.toBeNull();
  });

  it('цвет строки — переменная, заданная только у стекла', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    // Переменная определена внутри правил стекла, а не на :root: вне стекла её нет.
    const rootBlock = /:root\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rootBlock).not.toMatch(/--glass-fg-muted/);
    expect(css).toMatch(/\.fx-glass\s*\{[^}]*--glass-fg-muted/);
  });
});
