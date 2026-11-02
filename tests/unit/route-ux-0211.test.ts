import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const card = readFileSync('components/routes/RoutePathCard.tsx', 'utf8');
const page = readFileSync('app/routes/[id]/_RouteDetailClient.tsx', 'utf8');
describe('маршруты без фото и первый экран страницы (02.11)', () => {
  it('карточка без фото — полоса 56px, не 148px заглушки; заголовок до 3 строк', () => {
    expect(card).toContain('height: photoSrc ? 148 : 56');
    expect(card).toContain('line-clamp-3');
  });
  it('герой без фото 184px (шапка 64 + 120), вердикт сразу под фактами', () => {
    expect(page).toContain('useGradient ? { height: 184 }');
    expect(page.indexOf('data-testid="route-facts"')).toBeLessThan(page.indexOf('<RouteVerdict'));
  });
  it('баннеры безопасности на месте', () => {
    expect(page).toContain('В районе маршрута');
    expect(page).toContain('<RouteVerdict routeId={route.id} data={verdictData} />');
  });
});
