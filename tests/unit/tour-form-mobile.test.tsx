/**
 * Форма тура на узком экране: «Добавить» на месте, источник маршрута не в подписи, есть поиск.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TourForm } from '@/components/operator/Tours/TourForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('форма нового тура', () => {
  it('кнопки «Добавить» видны, маршрут без источника, поиск сужает список', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          { id: 'a', title: 'Авачинский', category: 'volcano', description: '', lat: null, lng: null, sourceName: 'visitkamchatka.ru' },
          { id: 'b', title: 'Халактырский пляж', category: 'beach', description: '', lat: null, lng: null, sourceName: 'visitkamchatka.ru' },
        ],
      }),
    })));
    render(<TourForm onSubmit={async () => undefined} onCancel={() => undefined} />);
    const add = await screen.findAllByRole('button', { name: 'Добавить' });
    expect(add.length).toBe(2);
    for (const button of add) expect(button.className).toMatch(/shrink-0/);
    const route = await screen.findByRole('combobox', { name: /Базовый маршрут/ });
    expect(route.textContent).toContain('Авачинский');
    expect(route.textContent).not.toContain('visitkamchatka.ru');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Найти маршрут' }), { target: { value: 'халак' } });
    expect(route.textContent).toContain('Халактырский пляж');
    expect(route.textContent).not.toContain('Авачинский');
  });
});