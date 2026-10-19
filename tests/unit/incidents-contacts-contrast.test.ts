import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Телефоны МЧС на /safety/incidents: в тёмной теме глобальный цвет ссылок
// (--ocean) красил их голубым на красном, а --danger светлел до #F85149.
// Плашка фиксированно #B91C1C, ссылки белые: 6,5:1, WCAG AA.
describe('/safety/incidents: экстренные телефоны контрастны', () => {
  const src = readFileSync(join(process.cwd(), 'app/safety/incidents/page.tsx'), 'utf8');
  it('плашка не зависит от темы', () => {
    expect(src).toMatch(/bg-\[#B91C1C\] rounded-lg p-5 text-white/);
  });
  it('ссылка-телефон сама белая во всех состояниях', () => {
    expect(src).toMatch(/className="text-white hover:text-white visited:text-white/);
    expect(src).not.toMatch(/opacity-70">\{c\.note\}/);
  });
});
