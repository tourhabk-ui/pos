/**
 * «Дом» в нижней навигации — домашние вулканы, не домик (владелец 04.10).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeVolcanoesIcon } from '@/components/shared/HomeVolcanoesIcon';

const NAV = readFileSync(join(process.cwd(), 'components/shared/BottomNav.tsx'), 'utf-8');

describe('иконка «Дом» — домашние вулканы', () => {
  it('BottomNav ставит HomeVolcanoesIcon на «Дом», домика lucide больше нет', () => {
    expect(NAV).toMatch(/icon: HomeVolcanoesIcon, label: 'Дом'/);
    expect(NAV).not.toMatch(/\bHouse\b/);
  });

  it('иконка по правилам ряда: currentColor, размер и толщина из пропсов, скрыта от скринридера', () => {
    const html = renderToStaticMarkup(<HomeVolcanoesIcon size={20} strokeWidth={2.2} />);
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('width="20"');
    expect(html).toContain('stroke-width="2.2"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
