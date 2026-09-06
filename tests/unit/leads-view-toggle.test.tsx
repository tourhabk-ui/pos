/**
 * tests/unit/leads-view-toggle.test.tsx
 *
 * Переключатель Список/Канбан в CRM-лидах (06.09) — выбор помнится per-viewer
 * в localStorage, список и канбан не показываются одновременно.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { LeadsClient } from '@/app/hub/admin/leads/_LeadsClient';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ leads: [], total: 0 }),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Список/Канбан', () => {
  it('по умолчанию — список: вкладки видны, канбан не смонтирован', async () => {
    render(<LeadsClient />);
    await waitFor(() => expect(screen.getByText('Все')).toBeTruthy());
    expect(screen.queryByText('Пусто')).toBeNull(); // маркер пустой колонки канбана
  });

  it('клик «Канбан» переключает вид и запоминает выбор', async () => {
    render(<LeadsClient />);
    await waitFor(() => expect(screen.getByText('Все')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Канбан'));

    await waitFor(() => expect(screen.getAllByText('Пусто').length).toBeGreaterThan(0));
    expect(screen.queryByText('Все')).toBeNull(); // вкладки списка скрыты
    expect(localStorage.getItem('leads-view')).toBe('kanban');
  });

  it('сохранённый выбор "kanban" в localStorage применяется при монтировании', async () => {
    localStorage.setItem('leads-view', 'kanban');
    render(<LeadsClient />);
    await waitFor(() => expect(screen.getAllByText('Пусто').length).toBeGreaterThan(0));
    expect(screen.queryByText('Все')).toBeNull();
  });
});
