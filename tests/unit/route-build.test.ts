/**
 * lib/on-route/route-build.ts — контракт построения пути (владелец 27.08, PR 5A).
 *
 * PR 5A подключает НУЛЬ реальных маршрутизаторов — только контракт и
 * машину состояний UI. Сторож держит две вещи: форма ответа совпадает с
 * тем, что задал владелец, и заглушка честно отвечает «unsupported», а не
 * выдумывает путь и не отвечает «не найдено» (это разные утверждения —
 * второе означало бы, что платформа искала).
 */
import { describe, it, expect } from 'vitest';
import {
  notWiredBuilder, BUILDER_NOT_WIRED_REASON,
  type RouteBuildRequest, type RouteBuildResult,
} from '@/lib/on-route/route-build';
import type { Destination } from '@/lib/on-route/destination';
import type { Origin } from '@/lib/on-route/origin';

const origin: Origin = { kind: 'current', lat: 53.0, lon: 158.6 };
const destination: Destination = { kind: 'place', id: 'p1', title: 'Вулкан Авачинский', lat: 53.25, lon: 158.83 };

describe('notWiredBuilder — честная заглушка до PR 5B', () => {
  it('отвечает unsupported, а не not_found: платформа не искала, а не «не нашла»', async () => {
    const req: RouteBuildRequest = { origin, destination, mode: 'foot' };
    const result = await notWiredBuilder.build(req);
    expect(result.status).toBe('unsupported');
  });

  it('причина — не пустая строка и не выдумка про конкретный маршрут', async () => {
    const result = await notWiredBuilder.build({ origin, destination, mode: 'car' });
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.reason).toBe(BUILDER_NOT_WIRED_REASON);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('ответ одинаково честен для обоих режимов — заглушка не притворяется, что поддерживает один из них', async () => {
    const foot = await notWiredBuilder.build({ origin, destination, mode: 'foot' });
    const car = await notWiredBuilder.build({ origin, destination, mode: 'car' });
    expect(foot).toEqual(car);
  });
});

describe('форма RouteBuildResult — ровно спецификация владельца', () => {
  it('found несёт options: RouteOption[]', () => {
    const r: RouteBuildResult = { status: 'found', options: [] };
    expect(r.status).toBe('found');
  });

  it('not_found и unsupported несут reason: string', () => {
    const a: RouteBuildResult = { status: 'not_found', reason: 'x' };
    const b: RouteBuildResult = { status: 'unsupported', reason: 'y' };
    expect(a.reason).toBe('x');
    expect(b.reason).toBe('y');
  });

  it('failed несёт retryable: boolean и message: string — оба обязательны', () => {
    const r: RouteBuildResult = { status: 'failed', retryable: true, message: 'сеть' };
    expect(r.retryable).toBe(true);
    expect(r.message).toBe('сеть');
  });
});
