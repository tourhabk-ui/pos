/**
 * lib/on-route/route-provider.ts — контракт автомобильного маршрутизатора
 * (владелец 28.08, PR 5B-1, инфраструктурная часть).
 *
 * Источник маршрутизации сознательно НЕ выбран (владелец попросил
 * спроектировать адаптер провайдер-агностично). Сторож держит две вещи:
 * заглушка честно отвечает `not_wired`, а не молчит и не выдумывает путь;
 * found/not_found НЕ добавлены в контракт — их форма зависит от реального
 * провайдера, придумывать её вслепую запрещено правилом §4.0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { notWiredCarRouteProvider, CAR_PROVIDER_NOT_WIRED_MESSAGE } from '@/lib/on-route/route-provider';

describe('notWiredCarRouteProvider — честная заглушка, источник не выбран', () => {
  it('отвечает not_wired на любой запрос', async () => {
    const result = await notWiredCarRouteProvider.route({
      originLat: 53.0, originLon: 158.6, destLat: 53.25, destLon: 158.83,
    });
    expect(result.status).toBe('not_wired');
    if (result.status === 'not_wired') {
      expect(result.message).toBe(CAR_PROVIDER_NOT_WIRED_MESSAGE);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('found/not_found сознательно не добавлены в контракт', () => {
  it('CarRouteProviderResult не обещает того, чего нет ни у одной реализации', () => {
    const src = readFileSync(join(process.cwd(), 'lib/on-route/route-provider.ts'), 'utf-8');
    expect(src).not.toMatch(/status: 'found'/);
    expect(src).not.toMatch(/status: 'not_found'/);
  });
});
