import { describe, it, expect } from 'vitest';
import { routeSlugPath, catalogHref } from '@/lib/routes/url-slug';

// Сыщик 21.11: ссылки на /routes/kl-* шли через 308 на статью.
describe('адрес маршрута-двойника статьи', () => {
  it('kl-* — сразу на /articles/*', () => {
    expect(routeSlugPath('kl-esso')).toBe('/articles/esso');
    expect(routeSlugPath('kl-ozero-azhabachje')).toBe('/articles/ozero-azhabachje');
    expect(catalogHref({ id: 'x', kind: 'route', urlSlug: 'kl-esso' }, '/routes')).toBe('/articles/esso');
  });
  it('обычный маршрут и место — как были', () => {
    expect(routeSlugPath('paratunka')).toBe('/routes/paratunka');
    expect(routeSlugPath('kl-')).toBe('/routes/kl-');
    expect(catalogHref({ id: 'p1', kind: 'place', urlSlug: 'kl-esso' }, '/places')).toBe('/places/kl-esso');
  });
});
