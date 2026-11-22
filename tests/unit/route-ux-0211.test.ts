import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const page = readFileSync('app/routes/[id]/_RouteDetailClient.tsx', 'utf8');
describe('маршруты без фото и первый экран страницы (02.11)', () => {
  it('герой без фото 184px (шапка 64 + 120), вердикт сразу под фактами', () => {
    expect(page).toContain('useGradient ? { height: 184 }');
    expect(page.indexOf('data-testid="route-facts"')).toBeLessThan(page.indexOf('RouteVerdict routeId='));
  });
  it('баннеры безопасности на месте', () => {
    expect(page).toContain('В районе маршрута');
    expect(page).toMatch(/RouteVerdict routeId=\{route.id\} data=\{verdictData\}/);
  });
});
