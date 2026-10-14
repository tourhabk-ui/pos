// @vitest-environment jsdom
/**
 * Что видит человек, когда сервер не принял запись из полевой очереди (#2448).
 *
 * До 14.10 наблюдение, отвергнутое сервером (мат, координаты вне края),
 * оставалось первым в очереди навсегда, а форма говорила «Сохранено на
 * телефоне. Отправится само, когда появится сеть. Ничего не потеряется».
 * Теперь отказ откладывается с причиной, форма показывает её сразу и не
 * обещает «уйдёт само», а отложенное в прошлый раз видно списком —
 * исправить или удалить.
 *
 * Рендером и кликами: подменены только IndexedDB (в памяти) и сеть.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueueRefusals } from '@/components/field/QueueRefusals';
import type { TrailObservationDraft } from '@/lib/offline/db';

const disk = vi.hoisted(() => ({ obs: new Map<string, unknown>() }));

vi.mock('@/lib/offline/db', () => ({
  listTrailObservations: async () => [...disk.obs.values()],
  queueTrailObservation: async (i: { id: string }) => { disk.obs.set(i.id, i); },
  deleteTrailObservation: async (id: string) => { disk.obs.delete(id); },
  listFieldChecks: async () => [],
  queueFieldCheck: async () => undefined,
  deleteFieldCheck: async () => undefined,
}));

import { ObservationSheet } from '@/components/field/ObservationSheet';

const PROFANITY = 'Сообщение содержит недопустимую лексику. Пожалуйста, перефразируйте.';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  cleanup();
  disk.obs.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const stored = () => [...disk.obs.values()] as TrailObservationDraft[];

function openSheet() {
  return render(<ObservationSheet open onClose={() => {}} lat={53.1} lng={158.6} />);
}

describe('блок «Сервер не принял»', () => {
  it('показывает запись, причину словами сервера и действия; пустой — не рисуется', () => {
    const onFix = vi.fn();
    const { container, rerender } = render(<QueueRefusals rows={[{
      id: 'a', title: 'Медведь · 13 окт., 14:05', excerpt: 'У ручья',
      reason: 'Координаты вне Камчатки — наблюдение не сохранено',
      photos: ['AAAA'], actions: [{ label: 'Исправить', onPress: onFix }],
    }]} />);

    expect(screen.getByRole('region', { name: 'Сервер не принял: 1' })).toBeInTheDocument();
    expect(screen.getByText('Медведь · 13 окт., 14:05')).toBeInTheDocument();
    expect(screen.getByText('Причина: Координаты вне Камчатки — наблюдение не сохранено')).toBeInTheDocument();
    expect(screen.getByAltText('Снимок 1')).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
    fireEvent.click(screen.getByRole('button', { name: 'Исправить' }));
    expect(onFix).toHaveBeenCalledTimes(1);

    rerender(<QueueRefusals rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('форма наблюдения при отказе сервера', () => {
  it('говорит причину, не обещает «уйдёт само» и оставляет текст; исправленное уходит и заменяет отложенное', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(reply(422, { success: false, error: PROFANITY }));
    openSheet();

    fireEvent.change(screen.getByPlaceholderText('Короткое описание'), { target: { value: 'плохие слова у ручья' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить наблюдение' }));

    expect(await screen.findByText(`Сервер не принял наблюдение: ${PROFANITY}. Исправьте и отправьте снова.`)).toBeInTheDocument();
    expect(screen.queryByText('Сохранено на телефоне')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Короткое описание')).toHaveValue('плохие слова у ручья');
    expect(stored()).toHaveLength(1);
    expect(stored()[0].rejected).toMatchObject({ part: 'record', status: 422, reason: PROFANITY });

    fetchMock.mockResolvedValueOnce(reply(201, { success: true, data: { id: 'r-1' } }));
    fireEvent.change(screen.getByPlaceholderText('Короткое описание'), { target: { value: 'медведица у ручья' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить наблюдение' }));

    expect(await screen.findByText('Наблюдение отправлено')).toBeInTheDocument();
    // Отложенное заменено исправленным: на телефоне не осталось ни того, ни другого.
    expect(stored()).toHaveLength(0);
  });

  it('отложенное в прошлый раз видно при открытии; «Исправить» возвращает его в форму', async () => {
    disk.obs.set('o1', {
      id: 'o1', reportType: 'hazard', text: 'Лежбище сивучей', lat: 0, lng: 0, photos: [], queuedAt: 1,
      rejected: { part: 'record', status: 422, reason: 'Координаты вне Камчатки — наблюдение не сохранено', at: 2 },
    } satisfies TrailObservationDraft);
    openSheet();

    expect(await screen.findByRole('region', { name: 'Сервер не принял: 1' })).toBeInTheDocument();
    expect(screen.getByText('Причина: Координаты вне Камчатки — наблюдение не сохранено')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Исправить' }));

    expect(screen.getByPlaceholderText('Короткое описание')).toHaveValue('Лежбище сивучей');
    expect(screen.getByRole('button', { name: 'Опасность' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('«Удалить» спрашивает и убирает отложенное с телефона', async () => {
    disk.obs.set('o1', {
      id: 'o1', reportType: 'animal', text: 'Лиса', lat: 53, lng: 158, photos: [], queuedAt: 1,
      rejected: { part: 'record', status: 400, reason: 'Неверные данные', at: 2 },
    } satisfies TrailObservationDraft);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    openSheet();

    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stored()).toHaveLength(0));
    await waitFor(() => expect(screen.queryByRole('region', { name: /Сервер не принял/ })).not.toBeInTheDocument());
  });

  it('без сети форма честно говорит «сохранено на телефоне»: отказ среды — не отказ записи', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    openSheet();

    fireEvent.change(screen.getByPlaceholderText('Короткое описание'), { target: { value: 'медведь на тропе' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить наблюдение' }));

    expect(await screen.findByText('Сохранено на телефоне')).toBeInTheDocument();
    expect(stored()[0].rejected ?? null).toBeNull();
  });
});
