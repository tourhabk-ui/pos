/**
 * Ширина страницы на компьютере — одно правило на три рода
 * (lib/layout/page-width, владелец 14.11 «do it»).
 *
 * Рендер: страница, переведённая на правило, стоит в контейнере своего рода.
 * Запрет (регулярка по исходнику — только «этого быть не должно», CLAUDE.md
 * §4): у переведённой страницы нет собственного контейнера `mx-auto max-w-*`.
 * Реестр MIGRATED растёт партиями; его сокращение — красное.
 *
 * /zh, /zh/catalog, конспекты и /transfers судятся рендером в своих тестах:
 * tests/unit/zh-quick.test.tsx, tests/unit/zh-pages.test.tsx,
 * tests/unit/transfers-page.test.tsx.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));

import FishIndexPage from '@/app/fish/page';
import { pageContainer, PAGE_MAX } from '@/lib/layout/page-width';
import { HOME_CONTAINER } from '@/lib/home/desktop-layout';

afterEach(cleanup);

describe('правило ширины', () => {
  it('три рода: витрина 1280, карточка 1152, чтение 768; поля одни', () => {
    expect(pageContainer('showcase')).toContain('max-w-[1280px]');
    expect(pageContainer('card')).toContain('max-w-6xl');
    expect(pageContainer('reading')).toContain('max-w-3xl');
    for (const w of ['showcase', 'card', 'reading'] as const) {
      expect(pageContainer(w)).toMatch(/\bmx-auto\b/);
      expect(pageContainer(w)).toContain('px-4 sm:px-6 xl:px-8');
    }
  });

  it('файлы правила читает Tailwind: иначе классы ширины не попадут в CSS', async () => {
    const cfg = (await import('../../tailwind.config')).default as { content: string[] };
    expect(cfg.content).toContain('./lib/layout/page-width.ts');
    expect(cfg.content).toContain('./lib/home/desktop-layout.ts');
  });

  it('главная — той же ширины витрины', () => {
    expect(HOME_CONTAINER).toContain(PAGE_MAX.showcase);
  });
});

describe('/fish: у витрины есть ширина и поля', () => {
  it('сетка видов — внутри контейнера витрины, а не от края до края', () => {
    const { container } = render(<FishIndexPage />);
    const grid = container.querySelector('a[href^="/fish/"]')?.closest('.grid') as HTMLElement;
    const shell = grid.parentElement as HTMLElement;
    expect(shell.className).toContain('max-w-[1280px]');
    expect(shell.className).toContain('px-4');
  });
});

/** Файлы, переведённые на правило: своего контейнера ширины в них нет. */
const MIGRATED = [
  'app/zh/page.tsx',
  'app/zh/catalog/page.tsx',
  'components/zh/ZhDetail.tsx',
  'components/zh/HarbinFlight.tsx',
  'components/transfers/TransfersPage.tsx',
  'app/fish/page.tsx',
];

describe('запрет: переведённая страница не держит свою ширину', () => {
  it.each(MIGRATED)('%s — без собственного mx-auto max-w-*', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).toMatch(/pageContainer\('(showcase|card|reading)'\)/);
    expect(src).not.toMatch(/mx-auto[^"'`]*\bmax-w-(?:xl|[2-7]xl|\[\d+px\])|\bmax-w-(?:xl|[2-7]xl|\[\d+px\])[^"'`]*mx-auto/);
  });

  it('реестр не сокращается', () => {
    expect(MIGRATED.length).toBeGreaterThanOrEqual(6);
  });
});
