/**
 * Встроенный блок «Спросить Кузьмича» вместо плавающей «Подобрать тур»
 * (владелец 19.10: «подобрать тур устарела, единственное — ссылка на ТГ
 * и MAX Кузьмича»).
 *
 * Контракт:
 *  - плавающего StickyLeadButton нет нигде: файл удалён, layout не монтирует;
 *  - блок — в потоке (без fixed), две ссылки Кузьмича с реальными URL из
 *    проекта (Telegram @kuzmichai_bot?start=lead, MAX id4101147649_bot),
 *    цели не ниже 44px, подписи на русском;
 *  - старой формулировки «Подобрать тур» в публичной разметке нет.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import KuzmichContacts, { KUZMICH_TELEGRAM_URL, KUZMICH_MAX_URL } from '@/components/shared/KuzmichContacts';
import BottomNav, { BOTTOM_NAV_HEIGHT_VAR } from '@/components/shared/BottomNav';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(BOTTOM_NAV_HEIGHT_VAR);
});

describe('блок «Спросить Кузьмича»', () => {
  it('две ссылки с реальными URL Кузьмича из проекта', () => {
    expect(KUZMICH_TELEGRAM_URL).toBe('https://t.me/kuzmichai_bot?start=lead');
    expect(KUZMICH_MAX_URL).toBe('https://max.ru/id4101147649_bot');
    render(<KuzmichContacts />);
    const tg = screen.getByRole('link', { name: /Кузьмич в Telegram/ });
    const max = screen.getByRole('link', { name: /Кузьмич в MAX/ });
    expect(tg.getAttribute('href')).toBe(KUZMICH_TELEGRAM_URL);
    expect(max.getAttribute('href')).toBe(KUZMICH_MAX_URL);
  });

  it('в потоке, не плавает и не перекрывает контент', () => {
    const { container } = render(<KuzmichContacts />);
    expect(container.innerHTML).not.toMatch(/\bfixed\b/);
    expect(container.querySelector('form')).toBeNull();
  });

  it('цели не ниже 44px', () => {
    render(<KuzmichContacts />);
    for (const name of [/Кузьмич в Telegram/, /Кузьмич в MAX/]) {
      expect(screen.getByRole('link', { name }).className).toContain('min-h-[44px]');
    }
  });

  it('стоит в потоке /transfers, каталога и карточек', () => {
    expect(read('components/transfers/TransfersPage.tsx')).toContain('KuzmichContacts');
    expect(read('app/catalog/(list)/page.tsx')).toContain('KuzmichContacts');
    expect(read('components/transfers/CarrierPage.tsx')).toContain('KUZMICH_TELEGRAM_URL');
    expect(read('app/catalog/tours/[id]/_TourDetailClient.tsx')).toContain('KUZMICH_TELEGRAM_URL');
    expect(read('app/_home/_HomeV8Client.tsx')).toContain('KUZMICH_TELEGRAM_URL');
  });
});

describe('плавающей «Подобрать тур» больше нет', () => {
  it('StickyLeadButton удалён, layout его не монтирует', () => {
    expect(existsSync(join(ROOT, 'components/shared/StickyLeadButton.tsx'))).toBe(false);
    expect(read('app/layout.tsx')).not.toContain('StickyLeadButton');
  });

  it('старой формулировки нет в публичной разметке', () => {
    for (const f of [
      'components/shared/KuzmichContacts.tsx',
      'components/transfers/TransfersPage.tsx',
      'components/transfers/CarrierPage.tsx',
      'app/catalog/(list)/page.tsx',
      'app/_home/_HomeV8Client.tsx',
    ]) {
      expect(read(f), f).not.toContain('Подобрать тур');
    }
  });
});

describe('таб-бар публикует свою высоту', () => {
  it('переменная выставляется при монтировании и снимается при уходе', () => {
    const { unmount } = render(<BottomNav activePath="/menu" />);
    expect(document.documentElement.style.getPropertyValue(BOTTOM_NAV_HEIGHT_VAR)).toMatch(/^\d+(\.\d+)?px$/);
    unmount();
    expect(document.documentElement.style.getPropertyValue(BOTTOM_NAV_HEIGHT_VAR)).toBe('');
  });
});
