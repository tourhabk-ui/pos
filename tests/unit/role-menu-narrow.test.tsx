// @vitest-environment jsdom
/**
 * Узкий экран кабинета (перенос из #2770, 24.10).
 *
 * - Меню «Войти как» на экране 390 px не уходит за левый край. Прежде оно
 *   стояло `absolute right-0 w-48` от кнопки: у кнопки ближе 192 px к левому
 *   краю начало меню оказывалось за экраном.
 * - Проценты дашборда администратора пишутся по-русски: «0,0 %», а не «0.0%».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { roleMenuBox } from '@/components/layout/RoleSwitcher';
import { formatRuPercent } from '@/lib/format/ru-percent';

describe('место меню «Войти как»', () => {
  it('у кнопки у левого края меню начинается внутри экрана 390 px', () => {
    const box = roleMenuBox(40, 390);
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.left + box.width).toBeLessThanOrEqual(390 - 8);
  });

  it('у кнопки у правого края меню прижато к ней и не выходит вправо', () => {
    const box = roleMenuBox(380, 390);
    expect(box.left).toBe(380 - 192);
    expect(box.left + box.width).toBeLessThanOrEqual(382);
  });

  it('на широком экране меню стоит у кнопки, как раньше', () => {
    expect(roleMenuBox(1100, 1280)).toEqual({ left: 1100 - 192, width: 192 });
  });

  it('экран уже меню — меню сжимается до экрана без отступов за край', () => {
    const box = roleMenuBox(150, 160);
    expect(box.left).toBe(8);
    expect(box.width).toBe(144);
  });
});

describe('открытое меню на экране 390 px', () => {
  let rect: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      right: 40, bottom: 48, left: 0, top: 12, width: 40, height: 36, x: 0, y: 12, toJSON() { return {}; },
    } as DOMRect);
  });
  afterEach(() => {
    rect.mockRestore();
    cleanup();
    vi.doUnmock('@/contexts/AuthContext');
    vi.doUnmock('next/navigation');
  });

  it('рисуется внутри окна и называет себя «Войти как»', async () => {
    vi.resetModules();
    vi.doMock('@/contexts/AuthContext', () => ({
      useAuth: () => ({
        user: { id: 'u', email: 'a@example.test', name: 'Админ', role: 'admin', roles: ['admin'] },
        switchRole: vi.fn(),
      }),
    }));
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
    const { RoleSwitcher } = await import('@/components/layout/RoleSwitcher');
    render(<RoleSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Переключить роль' }));
    const menu = await screen.findByRole('menu');
    const left = Number.parseFloat(menu.style.left);
    const width = Number.parseFloat(menu.style.width);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(382);
    expect(menu.textContent).toContain('Войти как');
  });
});

describe('проценты дашборда администратора', () => {
  it('ноль — «0,0 %», дробь — через запятую', () => {
    expect(formatRuPercent(0)).toBe('0,0 %');
    expect(formatRuPercent(12.5)).toBe('12,5 %');
    expect(formatRuPercent(3.456, 2)).toBe('3,46 %');
  });

  it('в дашборде не осталось процента через точку', () => {
    const page = readFileSync(join(process.cwd(), 'app/hub/admin/page.tsx'), 'utf8');
    expect(page).not.toContain('0.0%');
    expect(page).not.toMatch(/toFixed\(1\)\}%/);
    expect(page).not.toMatch(/suffix:\s*'%'/);
  });
});
