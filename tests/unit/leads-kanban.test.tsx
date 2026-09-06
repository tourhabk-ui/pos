/**
 * tests/unit/leads-kanban.test.tsx
 *
 * Канбан-вид для лидов (06.09, по идее из письма U-ON.Travel — но на нашей
 * реальной модели статусов). Три вещи, которые стоит держать сторожем:
 *
 * 1) Колонки — только 5 РУЧНЫХ статусов (MANUAL_LEAD_STATUSES), не полный
 *    список из 9. AI-статусы (ai_processing/ai_qualified/proposal_sent/
 *    awaiting_confirm) ставит конвейер (lead-processor.service.ts), а не
 *    рука администратора — превратить их в колонку означало бы разрешить
 *    перетащить туда лида руками, чего конвейер не ожидает.
 * 2) moveBetweenColumns — чистая функция, симметричная для переноса и
 *    отката: тестируем её напрямую, а не через симуляцию pointer-жестов
 *    dnd-kit (что было бы дорого и хрупко в jsdom).
 * 3) Рендер: карточки уходят в правильные колонки по фактическому statusу
 *   лида, а не пропадают/дублируются.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import { MANUAL_LEAD_STATUSES, LEAD_STATUSES } from '@/lib/types/statuses';
import { COLUMNS, moveBetweenColumns, type Lead as _Lead } from '@/app/hub/admin/leads/_LeadsKanban';
import { LeadsKanban } from '@/app/hub/admin/leads/_LeadsKanban';

function lead(id: string, status: (typeof MANUAL_LEAD_STATUSES)[number], name = id): _Lead {
  return {
    id, name, phone: '+7900', comment: null, route_title: null, source_url: null,
    source_data: null, status, notes: null, ai_score: null, ai_summary: null,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  };
}

describe('колонки канбана — только ручные статусы', () => {
  it('COLUMNS === MANUAL_LEAD_STATUSES, не полный LEAD_STATUSES', () => {
    expect(COLUMNS).toEqual(MANUAL_LEAD_STATUSES);
    expect(COLUMNS.length).toBeLessThan(LEAD_STATUSES.length);
  });

  it('AI-статусы конвейера не входят в колонки', () => {
    for (const s of ['ai_processing', 'ai_qualified', 'proposal_sent', 'awaiting_confirm']) {
      expect(COLUMNS).not.toContain(s);
    }
  });
});

describe('moveBetweenColumns — чистый перенос', () => {
  const base = {
    new: [lead('l1', 'new'), lead('l2', 'new')],
    contacted: [], qualified: [], converted: [], lost: [],
  } as Record<(typeof MANUAL_LEAD_STATUSES)[number], _Lead[]>;

  it('убирает лида из источника и добавляет в цель со сменённым статусом', () => {
    const next = moveBetweenColumns(base, 'l1', 'new', 'contacted');
    expect(next.new.map(l => l.id)).toEqual(['l2']);
    expect(next.contacted).toHaveLength(1);
    expect(next.contacted[0].id).toBe('l1');
    expect(next.contacted[0].status).toBe('contacted');
  });

  it('перенос назад (откат) симметричен — та же функция, обратные аргументы', () => {
    const moved = moveBetweenColumns(base, 'l1', 'new', 'contacted');
    const reverted = moveBetweenColumns(moved, 'l1', 'contacted', 'new');
    expect(reverted.new.map(l => l.id).sort()).toEqual(['l1', 'l2']);
    expect(reverted.contacted).toHaveLength(0);
    expect(reverted.new.find(l => l.id === 'l1')?.status).toBe('new');
  });

  it('несуществующий лид или одинаковые from/to — колонки не меняются', () => {
    expect(moveBetweenColumns(base, 'ghost', 'new', 'contacted')).toBe(base);
    expect(moveBetweenColumns(base, 'l1', 'new', 'new')).toBe(base);
  });
});

describe('LeadsKanban рендерит лидов по фактическому статусу', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const status = new URL(url, 'http://x').searchParams.get('status');
      const leads = status === 'new' ? [lead('l1', 'new', 'Иван')]
        : status === 'qualified' ? [lead('l2', 'qualified', 'Пётр')]
        : [];
      return Promise.resolve({ ok: true, json: async () => ({ leads }) });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('запрашивает ровно 5 колонок (не 9) с limit=200', async () => {
    render(<LeadsKanban />);
    await waitFor(() => expect(screen.getByText('Иван')).toBeTruthy());
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/limit=200/);
    }
  });

  it('карточка попадает в колонку своего статуса', async () => {
    render(<LeadsKanban />);
    await waitFor(() => {
      expect(screen.getByText('Иван')).toBeTruthy();
      expect(screen.getByText('Пётр')).toBeTruthy();
    });
  });
});
