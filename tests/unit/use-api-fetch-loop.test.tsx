/**
 * Регрессия: useApiFetch не должен зацикливаться, когда вызывающий передаёт
 * ИНЛАЙН transform/options (новая идентичность каждый рендер). Баг «Избранного»
 * (2026-07): вечный спиннер + долбёжка API, т.к. transform был в deps doFetch,
 * и эффект монтирования перезапускался каждый рендер.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useApiFetch } from '@/hooks/use-api-fetch';

describe('useApiFetch — инлайн transform не вызывает бесконечный цикл', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: [{ id: '1' }] }),
    }) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it('делает РОВНО один fetch при инлайн-transform, loading гаснет', async () => {
    const { result, rerender } = renderHook(() =>
      // transform и options — инлайн: новая идентичность на каждый рендер
      useApiFetch<{ id: string }[], { id: string }[]>(
        '/api/x',
        (d) => d ?? [],
        { errorMessage: 'Не удалось' },
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Дополнительные ре-рендеры с новой функцией transform не должны триггерить fetch
    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 30));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual([{ id: '1' }]);
    expect(result.current.error).toBe('');
  });

  it('при ошибке API гаснет loading и показывается errorMessage (не вечный спиннер)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, error: 'boom' }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useApiFetch<number[]>('/api/y', undefined, { errorMessage: 'Не удалось загрузить избранное' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Не удалось загрузить избранное');
  });
});
