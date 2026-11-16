// @vitest-environment jsdom
/**
 * Экран безопасности /safety: «источник не ответил» не выдаётся за «всё
 * спокойно» (§4.0; пустые catch на путях безопасности, слово владельца 16.11).
 *
 * До правки отказ сейсмики, вулканов и погоды глотался пустым catch, и экран
 * писал «Нет событий M2.5+ за последние сутки» и «Активных вулканических
 * предупреждений нет». Ответ не 2xx без `events` давал то же самое.
 *
 * Судится рендером экрана с подложенным fetch: что видит человек.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/SectionSwipeBar', () => ({ SectionSwipeBar: () => null, SAFETY_SECTION_ITEMS: [] }));
vi.mock('@/components/PWA/PushSafetyOffer', () => ({ PushSafetyOffer: () => null }));
vi.mock('@/components/safety/RescueChat', () => ({ default: () => null }));

import SafetyClient from '@/app/safety/_SafetyClient';

type Reply = { status: number; body: unknown } | 'network';

function stubFetch(replies: Record<string, Reply>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(replies).find((k) => url.startsWith(k));
    const reply: Reply = key ? replies[key] : { status: 200, body: {} };
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }));
}

const ZONES_OK: Reply = { status: 200, body: { ok: true, zones: [] } };

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openSections() {
  fireEvent.click(await screen.findByText('Сейсмика'));
  fireEvent.click(screen.getByText('Вулканическая активность'));
}

describe('/safety: отказ источника', () => {
  it('сеть упала — «не загрузилась», а не «нет событий» и не «предупреждений нет»', async () => {
    stubFetch({
      '/api/public/danger-summary': ZONES_OK,
      '/api/safety/seismic': 'network',
      '/api/safety/volcanic': 'network',
      '/api/safety/weather': 'network',
    });
    const { container } = render(<SafetyClient live={null} />);
    await waitFor(() => expect(container.textContent).toContain('не загрузилась'));
    await openSections();
    const text = container.textContent ?? '';
    expect(text).toContain('Сейсмика не загрузилась. Это не значит, что толчков не было');
    expect(text).toContain('Данные о вулканах не загрузились. Это не значит, что предупреждений нет');
    expect(text).toContain('Прогноз погоды не загрузился');
    expect(text).not.toContain('Нет событий M2.5+');
    expect(text).not.toContain('Активных вулканических предупреждений нет');
  });

  it('сервер ответил 500 с телом без events — тоже отказ', async () => {
    stubFetch({
      '/api/public/danger-summary': ZONES_OK,
      '/api/safety/seismic': { status: 500, body: { error: 'сбой' } },
      '/api/safety/volcanic': { status: 502, body: { error: 'сбой' } },
      '/api/safety/weather': { status: 200, body: {} },
    });
    const { container } = render(<SafetyClient live={null} />);
    await waitFor(() => expect(container.textContent).toContain('не загрузилась'));
    await openSections();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Нет событий M2.5+');
    expect(text).not.toContain('Активных вулканических предупреждений нет');
  });

  it('роут вулканов ответил 200, но новости не прочитались (error, total: null) — «не загрузились»', async () => {
    // Настоящая форма отказа /api/safety/volcanic: 200, пустой events, error,
    // коды KVERT с total: null (ревью безопасности #3461).
    stubFetch({
      '/api/public/danger-summary': ZONES_OK,
      '/api/safety/seismic': { status: 200, body: { events: [], source: 'kbgsras' } },
      '/api/safety/volcanic': { status: 200, body: { events: [], checked_at: null, statuses: { elevated: [], total: null, green: null, updated_at: null }, error: 'relation does not exist' } },
      '/api/safety/weather': { status: 200, body: { today: { temp: '+2°', precip: 'без осадков', wind: 'ветер 3 м/с', sky: null } } },
    });
    const { container } = render(<SafetyClient live={null} />);
    await openSections();
    await waitFor(() => expect(container.textContent).toContain('Данные о вулканах не загрузились. Это не значит, что предупреждений нет'));
    expect(container.textContent).not.toContain('Активных вулканических предупреждений нет');
  });

  it('новости прочитались пустыми, а коды KVERT нет (total: null) — тоже не «предупреждений нет»', async () => {
    stubFetch({
      '/api/public/danger-summary': ZONES_OK,
      '/api/safety/seismic': { status: 200, body: { events: [], source: 'kbgsras' } },
      '/api/safety/volcanic': { status: 200, body: { events: [], checked_at: '2026-11-16T07:00:00Z', statuses: { elevated: [], total: null, green: null, updated_at: null } } },
      '/api/safety/weather': { status: 200, body: { today: { temp: '+2°', precip: 'без осадков', wind: 'ветер 3 м/с', sky: null } } },
    });
    const { container } = render(<SafetyClient live={null} />);
    await openSections();
    await waitFor(() => expect(container.textContent).toContain('не загрузились'));
    expect(container.textContent).not.toContain('Активных вулканических предупреждений нет');
  });

  it('источник ответил пустым списком — «нет событий», без строки об отказе', async () => {
    stubFetch({
      '/api/public/danger-summary': ZONES_OK,
      '/api/safety/seismic': { status: 200, body: { events: [], source: 'kbgsras', checkedAt: '2026-11-16T07:00:00Z' } },
      '/api/safety/volcanic': { status: 200, body: { events: [], checked_at: '2026-11-16T07:00:00Z', statuses: { elevated: [], total: 30, green: 30, updated_at: '2026-11-16T07:00:00Z' } } },
      '/api/safety/weather': { status: 200, body: { today: { temp: '+2°', precip: 'без осадков', wind: 'ветер 3 м/с', sky: null } } },
    });
    const { container } = render(<SafetyClient live={null} />);
    await openSections();
    await waitFor(() => expect(container.textContent).toContain('Нет событий M2.5+ за последние сутки.'));
    const text = container.textContent ?? '';
    expect(text).toContain('Активных вулканических предупреждений нет.');
    expect(text).not.toContain('не загрузил');
    expect(text).toContain('Погода в Петропавловске');
  });
});
