// @vitest-environment jsdom
/**
 * Форма /field-check говорит правду об очереди (#2448) — рендером.
 *
 * До 14.10 полоса «Не отправлено: N. Уйдёт само, когда появится связь»
 * считала всё, что лежит на телефоне, — и проверку, которую сервер не
 * примет никогда (400 на форме). Она стояла первой и держала остальные, а
 * экран обещал, что всё уйдёт само. Теперь «уйдёт само» — только ждущие
 * связи; не принятые — отдельным блоком с причиной: отправить снова или
 * удалить.
 *
 * Подменены только IndexedDB (в памяти) и сеть.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { FieldCheckQueueItem } from '@/lib/offline/db';

const disk = vi.hoisted(() => ({ checks: new Map<string, unknown>() }));

vi.mock('@/lib/offline/db', () => ({
  listFieldChecks: async () => [...disk.checks.values()],
  queueFieldCheck: async (i: { id: string }) => { disk.checks.set(i.id, i); },
  deleteFieldCheck: async (id: string) => { disk.checks.delete(id); },
  listTrailObservations: async () => [],
  queueTrailObservation: async () => undefined,
  deleteTrailObservation: async () => undefined,
  saveFieldCheckArea: async () => undefined,
  getFieldCheckArea: async () => undefined,
  saveTrackDraft: async () => undefined,
  getTrackDraft: async () => undefined,
  clearTrackDraft: async () => undefined,
}));

import { FieldCheckClient } from '@/app/field-check/_FieldCheckClient';

function check(id: string, over: Partial<FieldCheckQueueItem> = {}): FieldCheckQueueItem {
  return {
    id, targetKind: 'route', targetId: 'route-1', verdict: 'wrong_location',
    reportedLat: 53.1, reportedLng: 158.6, accuracyM: 6, note: 'Точка у ручья, а не на перевале', tripTag: null,
    objectLat: null, objectLng: null, objectSource: null, photos: [], queuedAt: 1_760_000_000_000, ...over,
  };
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  cleanup();
  disk.checks.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('очередь на экране /field-check', () => {
  it('«уйдёт само» считает только ждущие связи; не принятая — отдельно, с причиной', async () => {
    disk.checks.set('c1', check('c1', {
      rejected: { part: 'record', status: 400, reason: 'Не указано, какую запись проверяли', at: 2 },
    }));
    disk.checks.set('c2', check('c2', { targetKind: 'place', targetId: 'place-7', note: null }));
    // Связи нет: ждущая проверка остаётся ждать.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<FieldCheckClient />);

    expect(await screen.findByText('Не отправлено: 1. Уйдёт само, когда появится связь.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Сервер не принял: 1' })).toBeInTheDocument();
    expect(screen.getByText('Причина: Не указано, какую запись проверяли')).toBeInTheDocument();
    expect(screen.getByText('Точка у ручья, а не на перевале')).toBeInTheDocument();
    // Отложенную досыл сам не шлёт: на сервер ушла только ждущая.
    const bodies = fetchMock.mock.calls.map(c => JSON.parse(String(c[1]?.body)) as { target_id: string | null });
    expect(bodies.map(b => b.target_id)).not.toContain('route-1');
  });

  it('«Отправить снова» снимает отметку и шлёт; принятая уходит с телефона и из блока', async () => {
    disk.checks.set('c1', check('c1', {
      rejected: { part: 'record', status: 400, reason: 'Неверные данные', at: 2 },
    }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, id: 'chk-1' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    render(<FieldCheckClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Отправить снова' }));

    await waitFor(() => expect(disk.checks.size).toBe(0));
    await waitFor(() => expect(screen.queryByRole('region', { name: /Сервер не принял/ })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.map(c => c[0])).toContain('/api/field-check/report');
  });
});
