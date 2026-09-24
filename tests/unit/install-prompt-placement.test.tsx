/**
 * Приглашение установить приложение не встаёт поверх пути покупки.
 *
 * Аудит П1, #100/#115: карточка «Камчатка в кармане» появлялась через 30 с
 * после beforeinstallprompt снизу экрана (z-[110]) на любой странице. На
 * карточке тура она закрывала цену и верх «Выбрать дату» (оранжевая
 * «Установить» прямо над оранжевой кнопкой брони), на десктопе — угол
 * «Хочу тур». «Позже» была ~36px — ниже тач-цели DS.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import React from 'react';

let pathname = '/map';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { InstallPrompt, installPromptHiddenOn } from '@/components/PWA/InstallPrompt';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe('где приглашение не показывается', () => {
  it.each([
    '/catalog', '/catalog/tours/27', '/marketplace', '/marketplace/tours/27', '/booking-success/5',
  ])('%s — путь покупки', p => {
    expect(installPromptHiddenOn(p)).toBe(true);
  });

  it.each(['/map', '/routes/abc', '/planning', '/places/x', '/catalogue-of-fish'])('%s — показывается', p => {
    expect(installPromptHiddenOn(p)).toBe(false);
  });
});

function fireInstallEvent() {
  const e = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
  e.prompt = () => Promise.resolve();
  e.userChoice = Promise.resolve({ outcome: 'dismissed' });
  window.dispatchEvent(e);
}

describe('компонент', () => {
  it('на карточке тура не появляется и через 30 с', () => {
    vi.useFakeTimers();
    pathname = '/catalog/tours/27';
    const { container } = render(<InstallPrompt />);
    act(() => { fireInstallEvent(); vi.advanceTimersByTime(31000); });
    expect(container.innerHTML, 'приглашение легло поверх цены и «Выбрать дату»').toBe('');
  });

  it('в поле появляется, и обе кнопки — тач-цели 44px', () => {
    vi.useFakeTimers();
    pathname = '/map';
    render(<InstallPrompt />);
    act(() => { fireInstallEvent(); vi.advanceTimersByTime(31000); });
    for (const name of ['Установить', 'Позже']) {
      expect(screen.getByRole('button', { name }).className, `«${name}» ниже 44px`).toMatch(/min-h-\[44px\]/);
    }
  });
});
