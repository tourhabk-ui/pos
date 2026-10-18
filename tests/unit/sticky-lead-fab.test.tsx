/**
 * Глобальная кнопка «Хочу тур» и таб-бар: кнопку видно, её можно нажать,
 * и она не предлагает вторую заявку рядом с только что созданной.
 *
 * ── Что нашлось (аудит П1, #61/#107/#131/#143/#145/#148) ──────────────────
 *
 *  - в покое прозрачность 70% и вечная пульсация на @keyframes внутри
 *    компонента (§3 запрещает @keyframes в компонентах);
 *  - на телефоне подпись скрыта (`hidden sm:inline`) — одна иконка чата;
 *  - `bottom-4` без учёта таб-бара: на /menu кнопка (z-50) лежала под баром
 *    (z-100), и elementFromPoint в её центре попадал в «На маршруте» —
 *    нажать её было нельзя;
 *  - на /booking-success висела безадресная вторая заявка поверх «Договор
 *    (PDF)» и «Мои бронирования».
 *
 * Высоту бара кнопка не угадывает: её публикует сам BottomNav переменной
 * --bottom-nav-h (где бара нет — переменной нет, и срабатывает запас 0px).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pathname = '/menu';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import StickyLeadButton from '@/components/shared/StickyLeadButton';
import BottomNav, { BOTTOM_NAV_HEIGHT_VAR } from '@/components/shared/BottomNav';

const SRC = readFileSync(join(process.cwd(), 'components/shared/StickyLeadButton.tsx'), 'utf-8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

afterEach(() => {
  cleanup();
  pathname = '/menu';
  document.documentElement.style.removeProperty(BOTTOM_NAV_HEIGHT_VAR);
});

describe('кнопка «Хочу тур»', () => {
  it('без @keyframes и без <style> в компоненте (§3)', () => {
    expect(code).not.toMatch(/@keyframes/);
    expect(code).not.toMatch(/<style>/);
    expect(code).not.toMatch(/lead-button-pulse/);
  });

  it('непрозрачная в покое', () => {
    pathname = '/menu';
    render(<StickyLeadButton />);
    const btn = screen.getByRole('button', { name: 'Оставить заявку на тур' });
    expect(btn.className, 'в покое снова полупрозрачная').not.toMatch(/(^|\s)opacity-\d+\b/);
  });

  it('с подписью и на телефоне', () => {
    render(<StickyLeadButton />);
    const btn = screen.getByRole('button', { name: 'Оставить заявку на тур' });
    const phoneLabel = [...btn.querySelectorAll('span')].find(s => !/\bhidden\b/.test(s.className) || /\bsm:hidden\b/.test(s.className));
    expect(phoneLabel?.textContent, 'на ширине меньше sm кнопка — голая иконка').toBe('Подобрать тур');
  });

  it('стоит над таб-баром по его собственной высоте', () => {
    render(<StickyLeadButton />);
    const btn = screen.getByRole('button', { name: 'Оставить заявку на тур' });
    expect(btn.getAttribute('style') ?? '', 'отступ снизу не учитывает таб-бар').toContain(`var(${BOTTOM_NAV_HEIGHT_VAR}`);
    expect(btn.className).not.toMatch(/\bbottom-\d/);
  });

  it('скрыта на экране успеха брони', () => {
    pathname = '/booking-success/42';
    const { container } = render(<StickyLeadButton />);
    expect(container.innerHTML, 'вторая безадресная заявка рядом с только что созданной').toBe('');
  });

  it('скрыта на карточках места и маршрута и на карте (аудит UI/UX 29.09)', () => {
    // Ложилась на вердикт «Не сегодня» и на счётчик точек; место не продают (§9).
    for (const p of ['/places/vulkan-ksudach', '/routes/vulkan-ksudach', '/map']) {
      pathname = p;
      const { container, unmount } = render(<StickyLeadButton />);
      expect(container.innerHTML, `кнопка снова на ${p}`).toBe('');
      unmount();
    }
  });

  it('скрыта на странице перевозчика — у неё своя заявка на машину (владелец 14.10)', () => {
    // Ложилась на галочку согласия заявки на машину; список /transfers не задет.
    pathname = '/transfers/shatun';
    const { container, unmount } = render(<StickyLeadButton />);
    expect(container.innerHTML, 'кнопка снова на странице перевозчика').toBe('');
    unmount();
    pathname = '/transfers';
    expect(render(<StickyLeadButton />).container.innerHTML, 'кнопка пропала на списке трансферов').not.toBe('');
  });

  it('списки маршрутов и мест не задеты', () => {
    for (const p of ['/routes', '/places']) {
      pathname = p;
      const { container, unmount } = render(<StickyLeadButton />);
      expect(container.innerHTML, `кнопка пропала на ${p}`).not.toBe('');
      unmount();
    }
  });

  it('на каталоге кнопки нет (владелец 19.10), подбор там — баннер планировщика и карточки', () => {
    for (const p of ['/catalog', '/catalog/tours/mestechko-kurilskoe-ozero']) {
      pathname = p;
      const { container, unmount } = render(<StickyLeadButton />);
      expect(container.innerHTML, `плавающая кнопка снова на ${p}`).toBe('');
      unmount();
    }
    // Сама кнопка и её форма на других страницах живут как раньше.
    pathname = '/marketplace';
    expect(render(<StickyLeadButton />).container.innerHTML, 'кнопка пропала везде, а не только на каталоге').not.toBe('');
  });
});

describe('таб-бар публикует свою высоту', () => {
  it('переменная выставляется при монтировании и снимается при уходе', () => {
    const { unmount } = render(<BottomNav activePath="/menu" />);
    expect(document.documentElement.style.getPropertyValue(BOTTOM_NAV_HEIGHT_VAR)).toMatch(/^\d+(\.\d+)?px$/);
    unmount();
    expect(document.documentElement.style.getPropertyValue(BOTTOM_NAV_HEIGHT_VAR)).toBe('');
  });

  it('неактивные пункты — --text-secondary и не мельче 12px (вариант А)', () => {
    render(<BottomNav activePath="/menu" />);
    const tury = screen.getByRole('link', { name: 'Туры' });
    expect(tury.style.color, '«Туры» снова плейсхолдерного цвета (1.84:1)').toBe('var(--text-secondary)');
    expect(parseFloat(tury.style.fontSize)).toBeGreaterThanOrEqual(12);
    // 11.5px без запрета переноса ломал «На маршруте» в две строки и
    // раздувал бар с 77 до 93px (снимок p1-after-menu390, 24.09).
    expect(tury.style.whiteSpace).toBe('nowrap');
  });
});
