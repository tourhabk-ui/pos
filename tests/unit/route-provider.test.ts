/**
 * lib/on-route/route-provider.ts — контракт автомобильного маршрутизатора
 * (владелец 28.08, PR 5B-1: инфраструктура + нормализованный found/not_found).
 *
 * Источник маршрутизации по-прежнему НЕ выбран (bake-off Yandex/2ГИС
 * предстоит) — `notWiredCarRouteProvider` остаётся единственной реализацией,
 * подключённой к /api/routes/build. found/not_found теперь в контракте:
 * форма зафиксирована региональным тестом владельца (реальный ответ
 * публичного демо-OSRM по координатам Камчатки), не выдумана вслепую.
 * Сторож держит: заглушка честно отвечает `not_wired`; snap-guard понижает
 * ненадёжно привязанный путь в `not_found`, а не рисует его как есть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  notWiredCarRouteProvider, fakeCarRouteProvider, fakeFarSnapCarRouteProvider,
  applySnapGuard, CAR_PROVIDER_NOT_WIRED_MESSAGE, SNAP_TOO_FAR_REASON,
} from '@/lib/on-route/route-provider';

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

describe('applySnapGuard — центральная политика, одна на все будущие адаптеры', () => {
  it('надёжная привязка (камчатская проба) — found проходит без изменений', async () => {
    const raw = await fakeCarRouteProvider.route({ originLat: 53.19, originLon: 158.45, destLat: 53.04, destLon: 158.65 });
    const guarded = applySnapGuard(raw);
    expect(guarded.status).toBe('found');
    if (guarded.status === 'found') {
      expect(guarded.route.kind).toBe('calculated_car');
      expect(guarded.route.distanceM).toBeGreaterThan(0);
    }
  });

  it('ненадёжная привязка (8.8 км, реальная межрегиональная проба) — понижается в not_found', async () => {
    const raw = await fakeFarSnapCarRouteProvider.route({ originLat: 53.19, originLon: 158.45, destLat: 55.75, destLon: 37.62 });
    expect(raw.status).toBe('found'); // сырой ответ провайдера — Ok, как реально ответил OSRM без ограничения радиуса
    const guarded = applySnapGuard(raw);
    expect(guarded).toEqual({ status: 'not_found', reason: SNAP_TOO_FAR_REASON });
  });

  it('статусы не found не трогает', () => {
    const notWired = { status: 'not_wired' as const, message: 'x' };
    expect(applySnapGuard(notWired)).toBe(notWired);
    const err = { status: 'error' as const, retryable: true, message: 'x' };
    expect(applySnapGuard(err)).toBe(err);
  });
});

describe('тестовые адаптеры — не подключены к продовому эндпоинту', () => {
  it('app/api/routes/build/route.ts зовёт notWiredCarRouteProvider, не fake*', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/routes/build/route.ts'), 'utf-8');
    expect(src).toContain('notWiredCarRouteProvider.route(');
    expect(src).not.toMatch(/fakeCarRouteProvider|fakeFarSnapCarRouteProvider/);
  });
});
