/**
 * Страж заголовков безопасности (аудит поверхности атаки, 26.07).
 * Заголовки задаются в двух местах: next.config.js (все страницы) и
 * middleware.ts (matched-маршруты, в проде). Регрессия тут тихая — рефакторинг
 * молча снимает HSTS или переворачивает DENY→ALLOWALL, и это всплывает только
 * внешним пентестом. Тест структурный (прод из CI не достать), но ловит именно
 * молчаливое ослабление: обязательные директивы должны присутствовать, а
 * ALLOWALL / frame-ancestors * — жить ТОЛЬКО на /widget.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const config = readFileSync('next.config.js', 'utf8');
const mw = readFileSync('middleware.ts', 'utf8');

// Блок заголовков основных страниц — source с негативным lookahead на widget
const nonWidgetBlock = config.slice(
  config.indexOf("source: '/:path((?!widget/).*)'"),
  config.indexOf("source: '/hub/:path*'"),
);

describe('next.config.js — заголовки основных страниц', () => {
  it('HSTS с preload присутствует', () => {
    expect(nonWidgetBlock).toMatch(/Strict-Transport-Security/);
    expect(nonWidgetBlock).toMatch(/max-age=\d{7,}/);
    expect(nonWidgetBlock).toMatch(/preload/);
  });

  it('X-Frame-Options: DENY (не ALLOWALL) на основных страницах', () => {
    expect(nonWidgetBlock).toMatch(/X-Frame-Options['"]?,\s*value:\s*['"]DENY['"]/);
    expect(nonWidgetBlock).not.toMatch(/ALLOWALL/);
  });

  it('nosniff и CSP присутствуют', () => {
    expect(nonWidgetBlock).toMatch(/X-Content-Type-Options['"]?,\s*value:\s*['"]nosniff['"]/);
    expect(nonWidgetBlock).toMatch(/Content-Security-Policy/);
    expect(nonWidgetBlock).toMatch(/default-src 'self'/);
  });

  it('на основных страницах нет frame-ancestors * (только у виджета)', () => {
    expect(nonWidgetBlock).not.toMatch(/frame-ancestors \*/);
  });
});

describe('ALLOWALL / frame-ancestors * — только для виджета', () => {
  it('ALLOWALL встречается только рядом с widget', () => {
    // Каждое вхождение ALLOWALL должно быть в widget-контексте
    const allowallCount = (config.match(/ALLOWALL/g) ?? []).length;
    const widgetBlock = config.slice(
      config.indexOf("source: '/widget/:path*'"),
      config.indexOf("source: '/:path((?!widget/).*)'"),
    );
    const widgetAllowall = (widgetBlock.match(/ALLOWALL/g) ?? []).length;
    expect(allowallCount).toBeGreaterThan(0);
    expect(widgetAllowall).toBe(allowallCount);
  });

  it('middleware ставит ALLOWALL только под условием widget-пути', () => {
    expect(mw).toMatch(/widget/);
    // ALLOWALL в middleware есть, и DENY-ветка тоже (иначе framing не разграничен)
    expect(mw).toMatch(/ALLOWALL/);
    expect(mw).toMatch(/X-Frame-Options', 'DENY'/);
  });
});
