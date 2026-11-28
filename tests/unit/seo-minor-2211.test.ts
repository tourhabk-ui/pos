/**
 * Минорные правки Сыщика по проду ea52848d2 (22.11): подвал экрана входа
 * /planner в серверном HTML, перелинковка /plans ↔ /planning ↔ /partners ↔
 * /planner, <main> у /planning, «Памятка перед маршрутом» для /prepare.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { showSiteFooter } from '@/lib/navigation/site-footer-paths';
import { PLATFORM_LINKS } from '@/lib/navigation/platform-links';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('правки Сыщика 22.11', () => {
  it('/planner: общий подвал не ставится, экран входа ставит его сам', () => {
    expect(showSiteFooter('/planner')).toBe(false);
    const page = read('app/planner/page.tsx');
    expect(page).toContain("import { Footer } from '@/components/layout/Footer';");
    const gate = page.slice(page.indexOf('PlannerLoginGate gate='));
    expect(gate.search(/<Footer(?: newsChannel=\{[^}]+\})? \/>/)).toBeGreaterThan(0);
  });

  it('перелинковка в теле страниц', () => {
    const plans = read('app/plans/page.tsx');
    for (const h of ['/planner', '/planning', '/partners']) expect(plans).toContain(`href="${h}"`);
    const partners = read('app/partners/_PartnersClient.tsx');
    for (const h of ['/planner', '/planning', '/plans']) expect(partners).toContain(`href="${h}"`);
    const gate = read('components/planner/PlannerLoginGate.tsx');
    for (const h of ['/planning', '/plans']) expect(gate).toContain(`href="${h}"`);
  });

  it('подвал и меню: /planner — «План с Кузьмичом», /prepare — «Памятка перед маршрутом»', () => {
    const label = (href: string) => PLATFORM_LINKS.find((l) => l.href === href)?.label;
    expect(label('/planner')).toBe('План с Кузьмичом');
    expect(label('/prepare')).toBe('Памятка перед маршрутом');
    expect(PLATFORM_LINKS.some((l) => /Подготовка к поездке|планирован/i.test(l.label))).toBe(false);
    for (const p of ['lib/landings/texts.ts', 'lib/landings/texts-hubs.ts']) expect(read(p)).not.toContain('[Подготовка к поездке](/prepare)');
  });

  it('/planning: контент вкладки — в main', () => {
    const c = read('app/planning/_PlanningClient.tsx');
    expect(c).toContain('<main className="max-w-2xl mx-auto px-4 py-6 pb-32 space-y-6">\n      {intro}');
  });
});
