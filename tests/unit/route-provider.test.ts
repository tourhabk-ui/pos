/**
 * lib/on-route/route-provider.ts — контракт автомобильного маршрутизатора
 * (владелец 28.08, PR 5B-1: инфраструктура + нормализованный found/not_found;
 * 28.08 «собираем свой» — подключение roadGraphCarProvider вместо ожидания
 * bake-off Yandex/2ГИС).
 *
 * found/not_found форма зафиксирована региональным тестом владельца
 * (реальный ответ публичного демо-OSRM по координатам Камчатки), не
 * выдумана вслепую. Сторож держит: заглушка `notWiredCarRouteProvider`
 * честно отвечает `not_wired` (используется как фолбэк, не в проде);
 * snap-guard отказывает, когда не привязан САМ СТАРТ, и называет подъездом
 * путь, чья ЦЕЛЬ дальше порога от дороги (правка 08.09, см. ниже) — эта
 * политика центральная и одинаковая для ЛЮБОГО подключённого провайдера,
 * включая настоящий (см. road-graph-car-provider.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  notWiredCarRouteProvider, fakeCarRouteProvider, fakeFarSnapCarRouteProvider,
  applySnapGuard, CAR_PROVIDER_NOT_WIRED_MESSAGE, SNAP_TOO_FAR_REASON,
} from '@/lib/on-route/route-provider';
import { carRouteReach, carApproachGapM, formatApproachGap } from '@/lib/on-route/calculated-route';

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

  it('далёкая ЦЕЛЬ (8.8 км) — это подъезд, а не отказ', async () => {
    // Правка 08.09. Прежде здесь стоял not_found, и это било по обычному
    // случаю: цели в списке — места (вершины, озёра, источники), дороги до
    // них нет почти никогда, и «путь не найден» приходил на КАЖДУЮ такую
    // цель. Тап по карте попадал рядом с дорогой и работал — ровно та
    // разница, на которую жаловался владелец.
    //
    // Подъезд остаётся подъездом: остаток до цели назван числом, и это
    // проверяется ниже. Опасность, ради которой ставился порог, закрыта не
    // отказом, а ИМЕНЕМ.
    const raw = await fakeFarSnapCarRouteProvider.route({ originLat: 53.19, originLon: 158.45, destLat: 55.75, destLon: 37.62 });
    expect(raw.status).toBe('found'); // сырой ответ провайдера — Ok, как реально ответил OSRM без ограничения радиуса
    const guarded = applySnapGuard(raw);
    expect(guarded.status).toBe('found');
    if (guarded.status === 'found') {
      expect(carRouteReach(guarded.route)).toBe('approach');
      expect(Math.round(carApproachGapM(guarded.route))).toBe(8804);
      expect(formatApproachGap(carApproachGapM(guarded.route))).toBe('8.8 км');
    }
  });

  it('не привязан САМ СТАРТ — отказ остаётся отказом', () => {
    // Ехать не с чего: показывать линию, начинающуюся неизвестно где, —
    // это и есть то враньё, ради которого порог заводился.
    const raw = {
      status: 'found' as const,
      route: {
        kind: 'calculated_car' as const,
        geometry: { type: 'LineString' as const, coordinates: [[158.4, 53.1], [158.5, 53.2]] as [number, number][] },
        distanceM: 1000, durationS: 120,
        originSnapped: { lat: 53.1, lon: 158.4, snapDistanceM: 9000 },
        destinationSnapped: { lat: 53.2, lon: 158.5, snapDistanceM: 10 },
        provider: 'test', builtAt: '2026-09-08T00:00:00.000Z',
        traffic: false, mayDisplay: true, mayNavigate: false, mayPersist: false,
      },
    };
    expect(applySnapGuard(raw)).toEqual({ status: 'not_found', reason: SNAP_TOO_FAR_REASON });
  });

  it('статусы не found не трогает', () => {
    const notWired = { status: 'not_wired' as const, message: 'x' };
    expect(applySnapGuard(notWired)).toBe(notWired);
    const err = { status: 'error' as const, retryable: true, message: 'x' };
    expect(applySnapGuard(err)).toBe(err);
  });
});

describe('тестовые адаптеры — не подключены к продовому эндпоинту', () => {
  it('app/api/routes/build/route.ts зовёт roadGraphCarProvider, не notWired/fake*', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/routes/build/route.ts'), 'utf-8');
    expect(src).toContain('roadGraphCarProvider.route(');
    expect(src).not.toMatch(/notWiredCarRouteProvider|fakeCarRouteProvider|fakeFarSnapCarRouteProvider/);
  });
});
