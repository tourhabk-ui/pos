'use client';

import { type ElementType, type ReactNode } from 'react';

interface SensitiveProps {
  children: ReactNode;
  /** Тег обёртки — по умолчанию span, для строчных значений в таблицах/карточках. */
  as?: ElementType;
  className?: string;
}

/**
 * Оборачивает персональные данные (телефон, email, имя контакта) в
 * back-office. Ничего не скрывает сама — реагирует на data-атрибут
 * `html[data-mask-sensitive="true"]`, который выставляет SensitiveMaskToggle
 * в шапке /hub/admin. Значение остаётся в DOM (не редактируется, не
 * убирается) — маскировка визуальная, для записи экрана демо, а не гейт
 * доступа: кто видит эту страницу, тот и так авторизован видеть данные.
 */
export function Sensitive({ children, as: Tag = 'span', className = '' }: SensitiveProps) {
  return (
    <Tag tabIndex={0} className={`sensitive-value ${className}`}>
      {children}
    </Tag>
  );
}
