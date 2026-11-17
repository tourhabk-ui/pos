/**
 * День наблюдения KVERT — один на карточку и на ответы агентам (#3487, пункт 18).
 *
 * Шивелуч, 17.11: карточка места писала «Наблюдение: 12 ноября», MCP —
 * «наблюдение 13.11». Поле одно (`volcano_status.observed_at`), но бейдж
 * печатал его сутками браузера или сервера, а MCP — сутками Камчатки.
 * Наблюдение 12.11 в 13:30 UTC по Камчатке (UTC+12) — уже 01:30 13.11.
 *
 * Проверяется то, что видит человек и агент: рендер бейджа, строка KVERT в
 * `get_volcano_status` и в `get_guardian_context` — на одной дате около
 * полуночи по Камчатке.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import VolcanoAccBadge from '@/components/places/VolcanoAccBadge';
import { volcanoObservationDate } from '@/lib/services/safety/kvert-vona';
import { kvertPhrase } from '@/lib/kuzmich/volcano-tool';
import { getGuardianContext } from '@/lib/kuzmich/guardian-context';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

afterEach(() => cleanup());

/** 12.11 13:30 UTC — по Камчатке 13.11 01:30. */
const AFTER_KAMCHATKA_MIDNIGHT = '2026-11-12T13:30:00Z';
/** 12.11 11:30 UTC — по Камчатке 12.11 23:30. */
const BEFORE_KAMCHATKA_MIDNIGHT = '2026-11-12T11:30:00Z';
const NOW = Date.parse('2026-11-13T02:00:00Z');

describe('правило дня', () => {
  it('сутки Камчатки, а не UTC', () => {
    expect(volcanoObservationDate(AFTER_KAMCHATKA_MIDNIGHT)).toBe('13.11.2026');
    expect(volcanoObservationDate(BEFORE_KAMCHATKA_MIDNIGHT)).toBe('12.11.2026');
    expect(volcanoObservationDate(AFTER_KAMCHATKA_MIDNIGHT, 'long')).toMatch(/^13 ноября 2026/);
  });

  it('нет даты или она не разбирается — дня нет', () => {
    expect(volcanoObservationDate(null)).toBeNull();
    expect(volcanoObservationDate(undefined)).toBeNull();
    expect(volcanoObservationDate('')).toBeNull();
    expect(volcanoObservationDate('вчера')).toBeNull();
  });
});

describe('карточка и агенты называют один день', () => {
  it('бейдж на карточке места', () => {
    render(<VolcanoAccBadge status={{
      colorCode: 'orange', ashHeightM: null, summary: null,
      sourceUrl: 'http://kvert.febras.net/', observedAt: AFTER_KAMCHATKA_MIDNIGHT,
    }} />);
    expect(screen.getByText(/Наблюдение: 13 ноября 2026/)).toBeTruthy();
    expect(screen.queryByText(/12 ноября/)).toBeNull();
  });

  it('get_volcano_status', () => {
    const line = kvertPhrase({
      ark: null, place_name: 'Шивелуч', name: 'Sheveluch', acc: 'orange',
      ash_height_m: null, observed_at: AFTER_KAMCHATKA_MIDNIGHT,
    }, NOW);
    expect(line).toContain('наблюдение 13.11.2026');
  });

  it('get_guardian_context', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) {
        return Promise.resolve({ rows: [{
          name: 'Шивелуч', description: 'Вулкан', location_type: 'volcano',
          lat: 56.65, lng: 161.36, hazard_types: null, difficulty_level: null, altitude_m: 3283,
          nearest_medical_km: null, sat_communicator_required: null, capacity_per_day: null,
          open_from_date: null, open_to_date: null, is_open: true, current_crowds: null,
          active_alerts: null, recommender_status: null, alert_message: null, alert_severity: null,
          tourists_today: null,
          volcano_acc: 'orange', volcano_ash_height_m: null, volcano_observed_at: AFTER_KAMCHATKA_MIDNIGHT,
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
    // Свежее наблюдение или уже старое (через неделю строка скажет «текущим
    // не считать») — день в строке тот же.
    expect(await getGuardianContext('Шивелуч')).toContain('наблюдение 13.11.2026');
  });
});
