/**
 * Страница плана показывает ту же сводку, что MCP кладёт в «Безопасность
 * и разрешения»: «Мутновский: не приближаться» не остаётся только в чате.
 * Формы не отправляются.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

const m = vi.hoisted(() => ({ loadActiveWarnings: vi.fn() }));
vi.mock('@/lib/safety/active-warnings', () => ({ loadActiveWarnings: m.loadActiveWarnings }));
vi.mock('next/dynamic', () => ({ default: () => function MapStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));
vi.mock('@/app/trip/[token]/_OfflineSave', () => ({ OfflineSave: () => null }));

import { safetyBlock, SAFETY_BLOCK_TITLE } from '@/lib/planner/day-card-view';
import { warningsFromRows } from '@/lib/safety/mchs-bulletin';
import { safetyNotesForSharedDays } from '@/lib/trips/plan-page-safety';
import { TripShareClient, type Trip } from '@/app/trip/[token]/_TripShareClient';

const TOKEN = '00000000-0000-4000-8000-000000000711';

describe('сводка МЧС на странице плана', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null } as Response)));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('«Мутновский: не приближаться» попадает в блок безопасности и на /trip', async () => {
    const warnings = warningsFromRows([{
      alert_type: 'volcanic_eruption',
      title: 'Вулкан Мутновский: не приближаться',
      description: 'Не приближаться к кратеру.',
      volcano_name: 'Мутновский',
      external_id: 'mchs-mut',
      affected_zones: ['avachinsky'],
      source_url: 'https://41.mchs.gov.ru/operativnaya-informaciya',
    }]);
    m.loadActiveWarnings.mockResolvedValue({ ok: true, warnings });
    const notes = await safetyNotesForSharedDays(
      [{ type: 'activity', zone: 'avachinsky', title: 'Малкинские источники', description: 'термальные источники' }],
      null,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toMatch(/Мутновский/);
    expect(notes[0]?.message).toMatch(/не приближаться/);
    const items = safetyBlock([{ day: 2, type: 'activity', title: 'Малкинские источники' }], notes);
    expect(items.map((it) => it.text).join('\n')).toMatch(/Мутновский: не приближаться/);

    const trip: Trip = {
      source: 'draft', id: TOKEN, title: 'План', arrival_date: '2026-11-24', departure_date: '2026-12-04',
      places: [], activities: [], transport_by_day: {},
      days: [{
        day: 2, type: 'activity', zone: 'avachinsky', title: 'Малкинские источники',
        description: '', activityType: 'thermal', priceFrom: 0, priceTo: 0,
        coords: [53.01, 158.65], defaultTransport: 'walking', allowedTransports: ['walking'],
        difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
      }],
      safety_notes: notes,
    };
    render(<TripShareClient trip={trip} token={TOKEN} />);
    expect(screen.getByText(SAFETY_BLOCK_TITLE)).toBeTruthy();
    expect(document.body.textContent).toMatch(/Мутновский: не приближаться/);
  });

  it('лента не прочиталась — сводку не выдумываем', async () => {
    m.loadActiveWarnings.mockResolvedValue({ ok: false, warnings: [] });
    expect(await safetyNotesForSharedDays(
      [{ type: 'activity', zone: 'avachinsky', title: 'Малкинские источники' }],
      '2026-11-24',
    )).toEqual([]);
  });
});
