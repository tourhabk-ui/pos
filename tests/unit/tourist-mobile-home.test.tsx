/**
 * Мобильная главная, аудит 24.10 (390px): бургер как на внутренних,
 * компактный подвал, кнопка лида не в одной строке с полем.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import HomeV8Client from '@/app/_home/_HomeV8Client';
import type { HomeV8Data } from '@/app/_home/data';
import type { HomeWeather } from '@/lib/weather/home-widget-types';

/** Виджет погоды здесь не предмет проверки: исход без сети и без цифр. */
const NO_WEATHER: HomeWeather = { kind: 'failed' };
const data: HomeV8Data = {
  safety: { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null },
  seismic: { events: [], source: 'none', updatedAt: null, checkedAt: null },
  radar: { hazards: [], center: { lat: 53.04, lng: 158.65, label: 'Петропавловск-Камчатский' } },
  zones: { open: 0, total: 0, updatedAt: null },
  plates: [], transfer: null, stay: null, explore: [], feed: [], stats: [], elements: [],
};

describe('мобильная главная', () => {
  it('бургер ведёт в /menu, подвал называет юрлицо, тема остаётся на экране', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { container } = render(<HomeV8Client data={data} weather={NO_WEATHER} />);
    expect(screen.getByRole('link', { name: 'Ещё — все разделы' }).getAttribute('href')).toBe('/menu');
    const foot = screen.getByRole('contentinfo');
    expect(foot).toHaveTextContent(/ИНН 4101147649/);
    expect(foot).toHaveTextContent('Оферта');
    expect(screen.getByRole('button', { name: /тема/i })).toBeInTheDocument();
    const css = container.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.v7 \.lead \.field\{[^}]*flex-direction:column/);
    expect(css).toMatch(/@media \(min-width:480px\)\{\.v7 \.lead \.field\{flex-direction:row/);
    const form = container.querySelector('#lead');
    expect(form).not.toBeNull();
    expect(form!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
