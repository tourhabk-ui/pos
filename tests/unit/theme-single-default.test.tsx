/**
 * Тема по умолчанию — одна, и первый визит не перекрашивает страницу.
 *
 * ── Что нашлось (аудит П1, #6/#103) ───────────────────────────────────────
 *
 * Умолчаний было два. Скрипт против вспышки в app/layout.tsx красил первый
 * кадр светлым, а ThemeProvider после гидрации ставил `saved ?? 'dark'` и
 * сразу записывал 'dark' в localStorage. Новый посетитель видел кремовую
 * страницу, через 3–5 секунд она становилась тёмной, на главной менялось
 * фото героя, и тёмная тема оставалась с человеком навсегда, хотя он её не
 * выбирал. Вдобавок провайдер до монтирования отдавал Fragment, после —
 * Provider: смена типа корня перемонтировала всё дерево.
 *
 * Решение владельца 24.09: по умолчанию — светлая.
 *
 * ── Что держит этот файл ──────────────────────────────────────────────────
 *
 *  - значение живёт в одном месте (lib/theme.ts), и скрипт layout строится
 *    из него, а не из своей строки;
 *  - скрипт, ИСПОЛНЕННЫЙ на пустом хранилище, красит тему по умолчанию;
 *  - провайдер берёт тему из data-theme, который уже покрасил скрипт, и не
 *    пишет kh-theme без нажатия переключателя;
 *  - провайдер не перемонтирует детей после гидрации.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React, { useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_THEME, THEME_STORAGE_KEY, themeBootScript } from '@/lib/theme';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
});

describe('одно значение по умолчанию', () => {
  it('по умолчанию — светлая (решение владельца 24.09)', () => {
    expect(DEFAULT_THEME).toBe('light');
  });

  it('скрипт layout строится из lib/theme, а не из своей строки', () => {
    const layout = read('app/layout.tsx');
    expect(layout, 'скрипт против вспышки не зовёт themeBootScript()').toContain('themeBootScript()');
    expect(layout, 'в layout снова своя копия умолчания темы').not.toMatch(/localStorage\.getItem\('kh-theme'\)/);
  });

  it('провайдер не выводит свою тему', () => {
    const ctx = read('contexts/ThemeContext.tsx');
    expect(ctx, "провайдер снова выдумывает 'dark' для пустого хранилища").not.toMatch(/\?\?\s*'dark'/);
    expect(ctx).toContain('DEFAULT_THEME');
    expect(ctx).toContain('readDomTheme');
  });
});

describe('скрипт против вспышки — исполненный', () => {
  function runBoot(stored: string | null | 'throw'): string | null {
    document.documentElement.removeAttribute('data-theme');
    const orig = window.localStorage.getItem.bind(window.localStorage);
    if (stored === 'throw') {
      Object.defineProperty(window.localStorage, 'getItem', {
        configurable: true,
        value: () => { throw new Error('denied'); },
      });
    } else if (stored !== null) {
      localStorage.setItem(THEME_STORAGE_KEY, stored);
    }
    try {
      new Function(themeBootScript())();
    } finally {
      if (stored === 'throw') {
        Object.defineProperty(window.localStorage, 'getItem', { configurable: true, value: orig });
      }
    }
    return document.documentElement.getAttribute('data-theme');
  }

  it('пустое хранилище — тема по умолчанию', () => {
    expect(runBoot(null)).toBe(DEFAULT_THEME);
  });
  it('мусор в хранилище — тема по умолчанию', () => {
    expect(runBoot('purple')).toBe(DEFAULT_THEME);
  });
  it('хранилище закрыто — тема по умолчанию', () => {
    expect(runBoot('throw')).toBe(DEFAULT_THEME);
  });
  it('старая запись kh-theme (её писал провайдер без выбора) не читается', () => {
    // До 24.09 провайдер записывал 'dark' каждому посетителю. Это не выбор
    // человека — решение «по умолчанию светлая» обязано дойти и до них.
    expect(THEME_STORAGE_KEY).not.toBe('kh-theme');
    localStorage.clear();
    localStorage.setItem('kh-theme', 'dark');
    new Function(themeBootScript())();
    expect(document.documentElement.getAttribute('data-theme')).toBe(DEFAULT_THEME);
    localStorage.removeItem('kh-theme');
  });
  it('сохранённый выбор важнее умолчания', () => {
    const other = DEFAULT_THEME === 'light' ? 'dark' : 'light';
    expect(runBoot(other)).toBe(other);
    expect(document.documentElement.classList.contains('dark')).toBe(other === 'dark');
  });
});

describe('провайдер', () => {
  let mounts = 0;
  let seen: string[] = [];
  let toggle: () => void = () => {};

  function Probe() {
    const { theme, toggleTheme } = useTheme();
    seen.push(theme);
    toggle = toggleTheme;
    useEffect(() => { mounts += 1; }, []);
    return null;
  }

  function mount(domTheme: 'light' | 'dark') {
    mounts = 0;
    seen = [];
    document.documentElement.setAttribute('data-theme', domTheme);
    render(<ThemeProvider><Probe /></ThemeProvider>);
  }

  it('берёт тему, уже покрашенную скриптом, и ничего не пишет без выбора', () => {
    mount('dark');
    expect(seen[seen.length - 1]).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY), 'kh-theme записан без нажатия переключателя').toBeNull();
  });

  it('первый визит: светлый кадр остаётся светлым, хранилище пусто', () => {
    mount('light');
    expect(seen[seen.length - 1]).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('не перемонтирует детей после гидрации', () => {
    mount('dark');
    expect(mounts, 'дерево под провайдером смонтировано дважды — корень сменил тип').toBe(1);
  });

  it('переключатель — единственное место, где выбор записывается', () => {
    mount('light');
    act(() => toggle());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
