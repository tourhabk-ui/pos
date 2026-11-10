/**
 * tests/unit/map-threat-panel.test.tsx
 *
 * Панель «Угрозы по районам» на полевой карте (#2930) — рендером. Что видит
 * человек:
 *  - плашка — кнопка, панель раскрывается по нажатию (aria-expanded);
 *  - районы из ленты: тревога под своим районом, пункт без района — отдельно,
 *    район без тревог — «тревог в ленте нет», оценка зоны — рядом;
 *  - без сети — последний ответ с его возрастом, а не «спокойно»;
 *  - ни сети, ни кеша — «неизвестно», ни одного тихого района;
 *  - оценка зон не ответила — «не прочиталась», а не «норма».
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, act, within } from '@testing-library/react';
import React from 'react';
import { MapThreatChip } from '@/components/map/MapThreatChip';

const FEED = {
  hasAlert: true, activeCount: 3, maxSeverity: 2, topTitle: 'Штормовое предупреждение: ветер до 25 м/с',
  feedCount: 2,
  feedTitles: ['Штормовое предупреждение: ветер до 25 м/с', 'Медведи у посёлка Термальный'],
  feedZones: [['eastern'], []],
};
const DANGER = { ok: true, zones: [{ zone: 'eastern', risk_level: 'high' }] };

type Route = Record<string, unknown | Error>;

/** fetch по адресу: тело ответа или ошибка сети. */
function mockFetch(routes: Route): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body = key ? routes[key] : undefined;
    if (body === undefined || body instanceof Error) throw body ?? new Error('нет сети');
    return new Response(JSON.stringify(body));
  });
}

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function openPanel(): Promise<HTMLElement> {
  render(<MapThreatChip />);
  await tick();
  const chip = screen.getByRole('button');
  expect(chip.getAttribute('aria-expanded')).toBe('false');
  await act(async () => { chip.click(); });
  await tick();
  expect(chip.getAttribute('aria-expanded')).toBe('true');
  return screen.getByRole('region', { name: 'Угрозы по районам' });
}

/** Пункт списка района по его имени. */
function district(panel: HTMLElement, name: string): HTMLElement {
  const title = within(panel).getByText(name);
  return title.closest('li') as HTMLElement;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('панель «Угрозы по районам»', () => {
  it('тревога — под своим районом, без района — отдельно, тихий район — «тревог в ленте нет»', async () => {
    mockFetch({ '/api/public/safety-status': { success: true, data: FEED }, '/api/public/danger-summary': DANGER });
    const panel = await openPanel();

    const east = district(panel, 'Восточная Камчатка');
    expect(east.textContent).toContain('Штормовое предупреждение: ветер до 25 м/с');
    expect(east.textContent).toContain('Расчётная оценка: высокая');
    expect(district(panel, 'Западная Камчатка').textContent).toContain('тревог в ленте нет');
    expect(district(panel, 'Западная Камчатка').textContent).not.toContain('Штормовое');

    const unzoned = within(panel).getByText('Район в сводке не указан').parentElement as HTMLElement;
    expect(unzoned.textContent).toContain('Медведи у посёлка Термальный');
    expect(within(panel).getByRole('link').getAttribute('href')).toBe('/safety#radar');
    expect(panel.textContent).toContain('112');
  });

  it('без сети — последний ответ с возрастом; оценка зон без кеша — «не прочиталась»', async () => {
    localStorage.setItem('vedar_map_threat', JSON.stringify({ data: FEED, ts: Date.now() - 5 * 3_600_000 }));
    mockFetch({});
    const panel = await openPanel();
    expect(panel.textContent).toMatch(/Лента — 5 ч назад, сейчас могла измениться/);
    expect(district(panel, 'Восточная Камчатка').textContent).toContain('Штормовое предупреждение');
    expect(panel.textContent).toContain('Расчётная оценка районов не прочиталась.');
    expect(panel.textContent).not.toMatch(/Расчётная оценка: норма/);
  });

  it('ни сети, ни кеша — районы «неизвестно», ни одного тихого', async () => {
    mockFetch({});
    const panel = await openPanel();
    expect(panel.textContent).toContain('Лента тревог не прочиталась');
    for (const name of ['Авачинско-Петропавловский', 'Восточная Камчатка', 'Западная Камчатка', 'Северная Камчатка']) {
      expect(district(panel, name).textContent).toMatch(/неизвестно/);
    }
    expect(panel.textContent).not.toContain('тревог в ленте нет');
  });

  it('источник недоступен, кеш есть — панель по кешу с возрастом, а не «неизвестно»', async () => {
    localStorage.setItem('vedar_map_threat', JSON.stringify({ data: FEED, ts: Date.now() - 2 * 3_600_000 }));
    mockFetch({ '/api/public/safety-status': { success: true, data: { unavailable: true } }, '/api/public/danger-summary': DANGER });
    const panel = await openPanel();
    expect(panel.textContent).toMatch(/Лента — 2 ч назад/);
    expect(district(panel, 'Восточная Камчатка').textContent).toContain('Штормовое предупреждение');
    // Недоступный источник не затирает известный ответ в кеше.
    const kept = JSON.parse(localStorage.getItem('vedar_map_threat') ?? '{}') as { data?: typeof FEED };
    expect(kept.data?.feedTitles).toEqual(FEED.feedTitles);
  });

  it('свежий ответ сети ложится в кеш с районами — офлайн-панели есть что показать', async () => {
    mockFetch({ '/api/public/safety-status': { success: true, data: FEED }, '/api/public/danger-summary': DANGER });
    await openPanel();
    const saved = JSON.parse(localStorage.getItem('vedar_map_threat') ?? '{}') as { data?: typeof FEED };
    expect(saved.data?.feedZones).toEqual(FEED.feedZones);
    expect(JSON.parse(localStorage.getItem('vedar_map_zone_risk') ?? '{}').data).toEqual(DANGER);
  });
});
