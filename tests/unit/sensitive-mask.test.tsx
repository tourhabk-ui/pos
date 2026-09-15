/**
 * tests/unit/sensitive-mask.test.tsx
 *
 * Маска чувствительных данных back-office (components/admin/shared/Sensitive.tsx,
 * SensitiveMaskToggle.tsx): значение остаётся в DOM (визуальная, не access-gate),
 * состояние переключателя переживает клики и сохраняется в localStorage под
 * своим ключом, чтобы не путаться с другими toggle-предпочтениями (`leads-view`
 * и т.п.), и синхронизирует data-mask-sensitive на <html> — единственный
 * механизм, на который реагирует CSS в globals.css.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { Sensitive } from '@/components/admin/shared/Sensitive';
import { SensitiveMaskToggle } from '@/components/admin/shared/SensitiveMaskToggle';

const STORAGE_KEY = 'vedar_admin_mask_sensitive';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.maskSensitive;
});

describe('Sensitive', () => {
  it('рендерит значение в DOM — маска визуальная (CSS), не скрывает данные от чтения', () => {
    render(<Sensitive>+7 900 123-45-67</Sensitive>);
    expect(screen.getByText('+7 900 123-45-67')).toBeInTheDocument();
  });

  it('вешает класс sensitive-value, на который реагирует html[data-mask-sensitive]', () => {
    render(<Sensitive>op@example.com</Sensitive>);
    expect(screen.getByText('op@example.com')).toHaveClass('sensitive-value');
  });

  it('фокусируема с клавиатуры (tabIndex) — реванш по :focus-visible без мыши', () => {
    render(<Sensitive>Иван Иванов</Sensitive>);
    expect(screen.getByText('Иван Иванов')).toHaveAttribute('tabIndex', '0');
  });
});

describe('SensitiveMaskToggle', () => {
  it('по умолчанию выключен — html без data-mask-sensitive="true"', () => {
    render(<SensitiveMaskToggle />);
    expect(document.documentElement.dataset.maskSensitive).toBe('false');
  });

  it('клик включает маску: атрибут на <html> и localStorage', () => {
    render(<SensitiveMaskToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.maskSensitive).toBe('true');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('второй клик выключает маску обратно', () => {
    render(<SensitiveMaskToggle />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(document.documentElement.dataset.maskSensitive).toBe('false');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0');
  });

  it('подхватывает сохранённое предпочтение при монтировании', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    render(<SensitiveMaskToggle />);
    expect(document.documentElement.dataset.maskSensitive).toBe('true');
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});
