/**
 * Форма тура на узком экране: «Добавить» на месте, источник маршрута не в подписи, есть поиск.
 * Поиск не прячет выбранный маршрут: что видно в списке, то и сохраняется.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { TourForm } from '@/components/operator/Tours/TourForm';

const ROUTES = [
  { id: 'a', title: 'Авачинский', category: 'volcano', description: '', lat: null, lng: null, sourceName: 'visitkamchatka.ru' },
  { id: 'b', title: 'Халактырский пляж', category: 'beach', description: '', lat: null, lng: null, sourceName: 'visitkamchatka.ru' },
];

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

  it('поиск, скрывший выбранный маршрут, не показывает «без привязки», а сохраняется видимое', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: ROUTES }) })));
    const onSubmit = vi.fn(async (_data: { routeId?: string }, _title?: string) => undefined);
    render(<TourForm onSubmit={onSubmit} onCancel={() => undefined} />);
    const route = await screen.findByRole('combobox', { name: /Базовый маршрут/ }) as HTMLSelectElement;
    await waitFor(() => expect(route.textContent).toContain('Авачинский'));
    fireEvent.change(screen.getByLabelText(/Название тура/), { target: { value: 'Восхождение на Авачинский' } });
    fireEvent.change(screen.getByLabelText(/Описание/), { target: { value: 'Однодневное восхождение с гидом на действующий вулкан' } });
    fireEvent.change(screen.getByLabelText(/Цена/), { target: { value: '15000' } });

    fireEvent.change(route, { target: { value: 'a' } });
    const search = screen.getByRole('searchbox', { name: 'Найти маршрут' });
    fireEvent.change(search, { target: { value: 'халак' } });
    expect(route.value).toBe('a');
    expect(route.selectedOptions[0]?.textContent).toBe('Авачинский');
    expect(route.textContent).toContain('Халактырский пляж');

    // Ничего не нашлось — так и сказано, а выбранный остаётся видимым.
    fireEvent.change(search, { target: { value: 'ключевская' } });
    expect(screen.getByText('Такого маршрута нет')).toBeTruthy();
    expect(route.selectedOptions[0]?.textContent).toBe('Авачинский');

    fireEvent.click(screen.getByRole('button', { name: 'Создать тур' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0].routeId).toBe('a');
    expect(onSubmit.mock.calls[0]?.[1]).toBe('Авачинский');

    // «Без привязки» выбирается и сохраняется пустым.
    fireEvent.change(search, { target: { value: 'халак' } });
    fireEvent.change(route, { target: { value: '' } });
    expect(route.selectedOptions[0]?.textContent).toMatch(/без привязки/);
    fireEvent.click(screen.getByRole('button', { name: 'Создать тур' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0].routeId).toBeUndefined();
  });
});
