'use client';

/**
 * ThemeContext -- управление светлой/темной темой.
 *
 * Тема применяется двумя способами для совместимости:
 *   1. Атрибут data-theme="dark"|"light" на <html> -- для CSS variables
 *   2. Класс `dark` на <html> -- для Tailwind darkMode: 'class'
 *
 * Значение по умолчанию и ключ хранилища — lib/theme.ts, одни на скрипт
 * против вспышки (app/layout.tsx) и на этот провайдер. Первый кадр красит
 * скрипт; провайдер после гидрации берёт тему из `data-theme`, который скрипт
 * уже выставил, а не выводит свою (до 24.09 выводил 'dark' и перекрашивал
 * страницу новому посетителю, #6/#103).
 *
 * localStorage[THEME_STORAGE_KEY] пишется только в toggleTheme — когда человек сам
 * выбрал тему. Провайдер всегда отдаёт Provider: замена Fragment на Provider
 * после монтирования меняла тип корня и перемонтировала всё дерево.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, THEME_STORAGE_KEY, readDomTheme, type Theme } from '@/lib/theme';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  toggleTheme: () => {},
  isDark: DEFAULT_THEME === 'dark',
});

function applyThemeToDOM(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Сервер и первый клиентский рендер обязаны совпасть — поэтому стартуем
  // с DEFAULT_THEME, а тему, уже покрашенную скриптом, читаем после монтирования.
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setTheme(readDomTheme());
  }, []);

  const toggleTheme = useCallback(() => {
    // От того, что реально на странице, а не от состояния провайдера:
    // тему может переключить и мобильная главная (HomeV8), мимо провайдера.
    const next: Theme = readDomTheme() === 'light' ? 'dark' : 'light';
    applyThemeToDOM(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Хранилище закрыто (приватное окно): выбор живёт до перезагрузки.
      console.error('[theme] выбор темы не сохранён — хранилище недоступно');
    }
    setTheme(next);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, isDark: theme === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
