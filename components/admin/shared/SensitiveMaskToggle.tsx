'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

const STORAGE_KEY = 'vedar_admin_mask_sensitive';

/**
 * Кнопка «скрыть чувствительные данные» для шапки back-office. Маскирует
 * все <Sensitive> на странице через атрибут data-mask-sensitive на <html>
 * (чистый CSS-селектор, без контекста и перерисовки дерева). Состояние —
 * личное предпочтение просмотра в этом браузере (перед записью демо),
 * не решение о доступе: хранится в localStorage, не на сервере.
 */
export function SensitiveMaskToggle() {
  const [masked, setMasked] = useState(false);

  useEffect(() => {
    let stored = false;
    try {
      stored = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // Приватный режим/запрет на storage — остаёмся с дефолтом «не скрыто».
    }
    setMasked(stored);
    document.documentElement.dataset.maskSensitive = stored ? 'true' : 'false';
  }, []);

  function toggle() {
    setMasked((prev) => {
      const next = !prev;
      document.documentElement.dataset.maskSensitive = next ? 'true' : 'false';
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Не удалось сохранить предпочтение — маска всё равно применится на эту сессию.
      }
      return next;
    });
  }

  return (
    <button
      onClick={toggle}
      className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      aria-label={masked ? 'Показать чувствительные данные' : 'Скрыть чувствительные данные'}
      aria-pressed={masked}
      title={masked ? 'Данные скрыты — наведи курсор на значение, чтобы увидеть' : 'Скрыть телефоны, email и имена контактов (для записи экрана)'}
    >
      {masked ? <EyeOff size={20} /> : <Eye size={20} />}
    </button>
  );
}
