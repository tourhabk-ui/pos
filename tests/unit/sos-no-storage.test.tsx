// @vitest-environment jsdom
/**
 * SOS на браузере без хранилища устройства (экран в машине, 21.11).
 *
 * Ловушка ошибок прода за 21.11: «Cannot read properties of null (reading
 * 'getItem')» — у встроенного браузера `window.localStorage` равен null.
 * Меш соседей (`VolcanoMesh`) читал хранилище в конструкторе без проверки, а
 * создаётся он, когда у /sos появились координаты: экран SOS падал в
 * «Произошла ошибка».
 *
 * Сторож держит:
 *   - меш создаётся и шлёт SOS, когда хранилища нет и когда доступ к нему
 *     бросает — вызовом;
 *   - отказ создания меша не роняет хук: статус «error», экран живёт —
 *     рендером хука с подставным мешем.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
function setStorage(desc: PropertyDescriptor) {
  Object.defineProperty(window, 'localStorage', { configurable: true, ...desc });
}
afterEach(() => {
  if (original) Object.defineProperty(window, 'localStorage', original);
  vi.doUnmock('@/lib/mesh/volcano-mesh');
  vi.resetModules();
});

describe('меш без хранилища устройства', () => {
  it('localStorage равен null — меш создаётся и шлёт SOS', async () => {
    setStorage({ value: null });
    const { VolcanoMesh } = await import('@/lib/mesh/volcano-mesh');
    let mesh: InstanceType<typeof VolcanoMesh> | null = null;
    expect(() => { mesh = new VolcanoMesh(); }).not.toThrow();
    expect(() => mesh!.sendSOS({ lat: 53, lng: 158 } as never)).not.toThrow();
  });

  it('доступ к localStorage бросает — меш создаётся', async () => {
    setStorage({ get() { throw new DOMException('denied', 'SecurityError'); } });
    const { VolcanoMesh } = await import('@/lib/mesh/volcano-mesh');
    expect(() => new VolcanoMesh()).not.toThrow();
  });
});

describe('отказ меша не роняет экран SOS', () => {
  it('конструктор бросил — хук жив, статус «error»', async () => {
    vi.doMock('@/lib/mesh/volcano-mesh', () => ({
      VolcanoMesh: class { constructor() { throw new Error('boom'); } },
    }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useMesh } = await import('@/hooks/use-mesh');
    const { result } = renderHook(() => useMesh(true, { lat: 53.02, lng: 158.65 }));
    expect(result.current.status).toBe('error');
    expect(err).toHaveBeenCalled();
  });
});
