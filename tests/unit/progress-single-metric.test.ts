/**
 * Прогресс и «до точки» — одна метрика пути, не две.
 *
 * «До следующей точки» на полевом экране считается вдоль трека (approach),
 * а «пройдено X из Y» считалось по прямым между путевыми точками. На
 * извилистом горном маршруте эти числа расходятся в полтора раза — и на
 * одном экране жили две разные длины одного пути.
 *
 * Инвариант: при наличии трека и шкалы плечи маршрута меряются вдоль трека
 * (distanceAlongTrack). Прямые между точками остаются только фолбэком
 * наброска — там пути в данных и нет — и случая, когда точки не ложатся на
 * трек по порядку (мерка вдоль него лгала бы).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeProgress } from '@/lib/on-route/eta';
import { distanceAlongTrack } from '@/lib/routes/relief';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('плечи прогресса меряются вдоль трека', () => {
  const client = read('app/planning/_PlanningClient.tsx');

  it('экран строит плечи через distanceAlongTrack при наличии трека', () => {
    const legs = client.slice(client.indexOf('const legKms'), client.indexOf('const progress'));
    expect(legs).toContain('distanceAlongTrack');
    expect(legs).toContain('trackDm');
  });

  it('без трека — честный фолбэк по прямым', () => {
    const legs = client.slice(client.indexOf('const legKms'), client.indexOf('const progress'));
    expect(legs).toMatch(/if \(!track.*return straight/s);
  });

  it('точки, не ложащиеся на трек по порядку, не мерятся вдоль него', () => {
    const legs = client.slice(client.indexOf('const legKms'), client.indexOf('const progress'));
    expect(legs).toMatch(/legs\.some\(l => l <= 0\)/);
  });
});

describe('движок прогресса согласован с меркой вдоль линии', () => {
  it('плечи вдоль трека дают ту же полную длину, что шкала трека', () => {
    // Прямой трек на север: точки маршрута стоят на нём же.
    const track: Array<[number, number]> = Array.from(
      { length: 101 },
      (_, i) => [53 + i * 0.001, 158] as [number, number],
    );
    // Шкала: метры вдоль трека на каждую точку (равномерный шаг).
    const stepM = 111.32; // 0.001° широты в метрах
    const dm = track.map((_, i) => i * stepM);
    const wps = [track[0], track[50], track[100]];
    const posM = wps.map(([lat, lng]) => distanceAlongTrack(track, lat, lng, dm));
    expect(posM.every(p => p !== null)).toBe(true);
    const legs = posM.slice(1).map((p, i) => ((p as number) - (posM[i] as number)) / 1000);
    const total = routeProgress(legs, 0, null).totalKm;
    // Полная длина по плечам совпадает с длиной шкалы (последняя отметка).
    expect(total).toBeCloseTo(dm[dm.length - 1] / 1000, 3);
  });
});
