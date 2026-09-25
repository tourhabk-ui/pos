/**
 * Петля онбординга (пакет A, находка 8).
 *
 * completeOnboarding глушил отказ PATCH и всё равно уводил в кабинет; гейт
 * кабинета видел onboarding_completed = false и молча возвращал в визард.
 * Хук общий для guide/agent/gear/stay — у оператора свой визард.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

import { usePartnerOnboarding } from '@/components/hub/usePartnerOnboarding';

const PROFILE = { id: 'p1', name: 'Гид', description: null, contact: null, onboarding_completed: false };

function stubFetch(patch: { ok: boolean; body: unknown } | 'network') {
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    if (!init || init.method !== 'PATCH') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { partner: PROFILE } }) });
    }
    if (patch === 'network') return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: patch.ok, status: patch.ok ? 200 : 500, json: async () => patch.body });
  }));
}

beforeEach(() => replaceMock.mockReset());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('completeOnboarding', () => {
  it('отказ сервера — остаёмся в визарде и видим причину', async () => {
    stubFetch({ ok: false, body: { success: false, error: 'Ошибка при сохранении профиля' } });
    const { result } = renderHook(() => usePartnerOnboarding('/hub/guide'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.completeOnboarding('/hub/guide'); });
    expect(ok).toBe(false);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(result.current.completeError).toBe('Ошибка при сохранении профиля');
  });

  it('сеть недоступна — тоже не уводим', async () => {
    stubFetch('network');
    const { result } = renderHook(() => usePartnerOnboarding('/hub/gear'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.completeOnboarding('/hub/gear'); });
    expect(replaceMock).not.toHaveBeenCalled();
    expect(result.current.completeError).toMatch(/Сеть недоступна/);
  });

  it('успех — переход в кабинет', async () => {
    stubFetch({ ok: true, body: { success: true } });
    const { result } = renderHook(() => usePartnerOnboarding('/hub/guide'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.completeOnboarding('/hub/guide'); });
    expect(replaceMock).toHaveBeenCalledWith('/hub/guide');
    expect(result.current.completeError).toBeNull();
  });
});
