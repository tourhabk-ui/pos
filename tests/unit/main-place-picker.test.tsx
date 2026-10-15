/**
 * Выбор главного места тура в кабинете (аудит 15.10, TOUR-PLACE) — рендером.
 *
 * Связь «тур → место» пишется адресом места из справочника, не свободным
 * текстом (§14: «Авачинский» — и вулкан, и перевал, и бухта). Здесь — что
 * видит оператор: найденные места кнопками, выбранное словами, откуда
 * сохранённая связь, и разница между «ничего не нашлось» и «поиск не
 * ответил» (§4.0).
 */
import React, { useState } from 'react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import MainPlacePicker, { type MainPlaceValue, type MainPlaceSource } from '@/components/operator/Tours/MainPlacePicker';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

function Harness({ initial, savedSource, savedId, onChange }: {
  initial: MainPlaceValue | null; savedSource: MainPlaceSource; savedId: string | null;
  onChange?: (v: MainPlaceValue | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MainPlacePicker
      value={value} savedSource={savedSource} savedId={savedId}
      onChange={(v) => { setValue(v); onChange?.(v); }}
    />
  );
}

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

describe('выбор главного места тура', () => {
  it('поиск по справочнику → выбор кнопкой → выбранное словами; запрос идёт в /api/places', async () => {
    fetchMock.mockResolvedValue(ok([
      { id: 'vulkan-gorelyj', name: 'Вулкан Горелый', locationType: 'volcano' },
      { id: 'gorelyj-peshchery', name: 'Лавовые пещеры Горелого', locationType: 'cave' },
    ]));
    const picked = vi.fn();
    render(<Harness initial={null} savedSource={null} savedId={null} onChange={picked} />);
    expect(screen.getByText(/Не выбрано/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Главное место тура/), { target: { value: 'Горел' } });
    const btn = await screen.findByRole('button', { name: /Вулкан Горелый/ });
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/places?q=${encodeURIComponent('Горел')}&limit=8`);

    fireEvent.click(btn);
    expect(picked).toHaveBeenCalledWith({ id: 'vulkan-gorelyj', name: 'Вулкан Горелый' });
    expect(document.querySelector('[data-main-place-name]')?.textContent).toBe('Вулкан Горелый');
    expect(screen.getByText('Новый выбор — сохранится вместе с туром.')).toBeTruthy();
    // Список закрылся — второй раз то же место не выбрать случайно.
    expect(screen.queryByRole('button', { name: /Лавовые пещеры/ })).toBeNull();
  });

  it('связь, поставленная по координатам, названа так и просит проверки; «Снять» её убирает', () => {
    const picked = vi.fn();
    render(<Harness initial={{ id: 'vulkan-gorelyj', name: 'Вулкан Горелый' }} savedSource="coords_equal" savedId="vulkan-gorelyj" onChange={picked} />);
    expect(screen.getByText(/координаты тура совпали с координатами этого места/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Снять/ }));
    expect(picked).toHaveBeenCalledWith(null);
    expect(document.querySelector('[data-main-place-name]')).toBeNull();
  });

  it('выбор оператора назван выбором оператора', () => {
    render(<Harness initial={{ id: 'p1', name: 'Озеро' }} savedSource="operator" savedId="p1" />);
    expect(screen.getByText('Выбрано в кабинете.')).toBeTruthy();
  });

  it('поиск не ответил — так и сказано, а не «не нашлось»', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ success: false }) });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Harness initial={null} savedSource={null} savedId={null} />);
    fireEvent.change(screen.getByLabelText(/Главное место тура/), { target: { value: 'Кроноцк' } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Поиск мест не ответил/);
    expect(screen.queryByText(/не нашлось/)).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('пусто — «не нашлось», без тревоги', async () => {
    fetchMock.mockResolvedValue(ok([]));
    render(<Harness initial={null} savedSource={null} savedId={null} />);
    fireEvent.change(screen.getByLabelText(/Главное место тура/), { target: { value: 'Несуществующее' } });
    await waitFor(() => expect(screen.getByText(/такого не нашлось/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('одна буква — поиск не зовётся', async () => {
    render(<Harness initial={null} savedSource={null} savedId={null} />);
    fireEvent.change(screen.getByLabelText(/Главное место тура/), { target: { value: 'А' } });
    await new Promise((r) => setTimeout(r, 350));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
