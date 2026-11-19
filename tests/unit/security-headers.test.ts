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

// Блок заголовков основных страниц — source с негативным lookahead на widget,
// до следующей записи (кэш картинок). Конец среза раньше искался по
// '/hub/:path*'; с 29.09 такой строки нет, и indexOf -1 молча растянул бы
// срез до конца файла. Поэтому оба края проверяются.
const blockStart = config.indexOf("source: '/:path((?!widget/).*)'");
const blockEnd = config.indexOf("source: '/images/:path*'");
const nonWidgetBlock = config.slice(blockStart, blockEnd);

describe('next.config.js — заголовки основных страниц', () => {
  it('срез блока найден с обоих краёв', () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
  });

  it('HSTS: от двух лет, с поддоменами, без «preload» — домен в список предзагрузки не подан (#3463)', async () => {
    const { createRequire } = await import('node:module');
    const cfg = createRequire(import.meta.url)(`${process.cwd()}/next.config.js`) as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const block = (await cfg.headers()).find((b) => b.source === '/:path((?!widget/).*)');
    const hsts = block?.headers.find((h) => h.key === 'Strict-Transport-Security')?.value ?? '';
    expect(Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0)).toBeGreaterThanOrEqual(63072000);
    expect(hsts).toMatch(/includeSubDomains/);
    expect(hsts).not.toMatch(/preload/);
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

describe('CSP без лишних чужих источников скриптов и стилей', () => {
  // unpkg.com стоял в script-src и style-src с давних времён, хотя ни один
  // скрипт и стиль сайта с него не грузится (аудит 09.11, снят 16.11 словом
  // владельца «карт-бланш»). Лишний источник в script-src — лишняя дверь для
  // чужого кода.
  //
  // Судится не текст файла, а сами источники политики: значения CSP из
  // next.config.js и строки директив из middleware.ts разбираются на токены.
  // Хост в CSP сравнивается без учёта регистра, схема необязательна, бывает
  // `*.` и порт — поэтому `unpkg.com`, `*.unpkg.com`, `HTTPS://unpkg.com` и
  // `unpkg.com:443` запрещены так же, как `https://unpkg.com` (находка ревью
  // безопасности к #3438: первая редакция ловила только последний).
  const UNPKG = /^(?:[a-z][a-z0-9+.-]*:)?(?:\/\/)?(?:\*\.)?unpkg\.com(?::\d+)?(?:\/\S*)?$/i;

  /** Источники всех директив CSP: из next.config.js и из middleware.ts. */
  function cspTokens(): string[] {
    const values = [...config.matchAll(/key: 'Content-Security-Policy', value: `([^`]+)`/g)].map((m) => m[1]!);
    const mwDirectives = [...mw.matchAll(/const \w+Src = "([^"]+)";/g)].map((m) => m[1]!);
    return [...values, ...mwDirectives]
      .flatMap((v) => v.split(/[;\s]+/))
      .filter(Boolean);
  }

  it('источники найдены в обоих местах — сторож не пустой', () => {
    const tokens = cspTokens();
    expect(tokens).toContain("'self'");
    expect(tokens.filter((t) => t === 'https://mc.yandex.ru').length, 'Метрика есть и в next.config.js, и в middleware.ts').toBeGreaterThanOrEqual(2);
  });

  it('распознаватель ловит все формы хоста', () => {
    for (const t of ['https://unpkg.com', 'unpkg.com', '*.unpkg.com', 'https://*.unpkg.com', 'HTTPS://UNPKG.COM', 'http://unpkg.com', 'unpkg.com:443', 'https://unpkg.com/leaflet@1.9.4/']) {
      expect(UNPKG.test(t), t).toBe(true);
    }
    for (const t of ['https://mc.yandex.ru', "'self'", 'https:', 'blob:', 'https://notunpkg.com']) {
      expect(UNPKG.test(t), t).toBe(false);
    }
  });

  it('unpkg.com нет ни в одной директиве CSP', () => {
    expect(cspTokens().filter((t) => UNPKG.test(t))).toEqual([]);
  });
});
