import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Корзина живёт внутри HubLayout кабинета: своя шапка сайта дублировала
// шапку кабинета и вторую SOS-кнопку на мобильном (аудит 20.10).
describe('корзина туриста: одна шапка', () => {
  it('страница корзины не рисует свою Header', () => {
    const src = readFileSync(join(process.cwd(), 'app/hub/tourist/cart/page.tsx'), 'utf8');
    expect(src).not.toMatch(/components\/layout\/Header/);
    expect(src).not.toMatch(/<Header\b/);
  });
});
