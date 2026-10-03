import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReliefChart from '@/components/routes/ReliefChart';

// 03.10: профиль высот, который сервер уже считал, дошёл до карточки маршрута.
describe('график высот на карточке маршрута', () => {
  const pts = [{ dM: 0, zM: 300 }, { dM: 2500, zM: 900 }, { dM: 5200, zM: 650 }];

  it('рисует линию и подписывает крайние высоты и длину', () => {
    const html = renderToStaticMarkup(createElement(ReliefChart, { points: pts, minM: 300, maxM: 900, source: null }));
    expect(html).toContain('<polyline');
    expect(html).toContain('900 м');
    expect(html).toContain('300 м');
    expect(html).toContain('5.2 км');
    expect(html).not.toContain('по модели рельефа');
  });

  it('высоты из модели рельефа подписаны словами', () => {
    const html = renderToStaticMarkup(createElement(ReliefChart, { points: pts, minM: null, maxM: null, source: 'dem' }));
    expect(html).toContain('по модели рельефа');
  });

  it('меньше двух точек — графика нет вовсе', () => {
    expect(renderToStaticMarkup(createElement(ReliefChart, { points: [pts[0]], minM: 1, maxM: 1, source: null }))).toBe('');
  });

  it('карточка рисует только надёжный профиль', () => {
    const src = readFileSync('app/routes/[id]/_RouteDetailClient.tsx', 'utf8');
    expect(src).toMatch(/route\.relief\?\.reliable === true/);
    expect(src).toMatch(/<ReliefChart\b/);
  });
});
