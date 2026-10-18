/**
 * Вариант А (аудит 18.10, PR 19.10): подписи публичных страниц — минимум 12px,
 * базовый текст карточек/форм — 15–16px на телефоне. Точечно, без смены
 * дизайн-системы: сторож держит конкретные места, а не весь CSS. Осознанный
 * микротекст (кредит фото, юр. сноски моноширинным) сюда не входит.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const HOME = read('app/_home/_HomeV8Client.tsx');
const CATALOG = read('components/marketplace/MarketplaceClient.tsx');
const TOUR = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
const NAV = read('components/shared/BottomNav.tsx');

describe('нижнее меню и главная (мобильная)', () => {
  it('подписи таб-бара — 12px', () => {
    expect(NAV).toContain("fontSize: '12px'");
    expect(NAV).not.toContain("fontSize: '11px'");
  });

  it('массовые подписи главной подняты до 12px', () => {
    for (const sel of ['.v7 .ptag{font:400 12px', '.v7 .pill{', '.v7 .hero-kick{margin-bottom:10px;font:600 12px',
      '.v7 .hchip{', '.v7 .qt-tx > span{font:500 12px', '.v7 .vchip{display:inline-flex;align-items:center;gap:6px;font:600 12px',
      '.v7 .ts-tile span{font:500 12px', '.v7 .lead .chip{']) {
      expect(HOME, `селектор ${sel} не поднят до 12px`).toContain(sel);
    }
    expect(HOME).toMatch(/\.v7 \.pill\{[^}]*font:600 12px/);
    expect(HOME).toMatch(/\.v7 \.hchip\{[^}]*font:600 12px/);
  });

  it('лид-форма: ввод 16px (без авто-зума iOS), вводный текст 15px', () => {
    expect(HOME).toMatch(/\.v7 \.lead \.lfield>input\{[^}]*font:500 16px/);
    expect(HOME).toMatch(/\.v7 \.lead \.field input\{[^}]*font:500 16px/);
    expect(HOME).toMatch(/\.v7 \.lead p\{[^}]*font:400 15px/);
  });
});

describe('каталог и карточка тура', () => {
  it('карточка каталога: подписи 12px, описание 15px', () => {
    expect(CATALOG).not.toContain('text-[11px]');
    expect(CATALOG).toContain('text-[15px] leading-snug');
  });

  it('карточка тура: eyebrow, статус и подписи фактов — 12px', () => {
    expect(TOUR).not.toContain('text-[11px]');
    expect(TOUR).not.toContain('text-[9px]');
    expect(TOUR).toMatch(/text-xs uppercase tracking-\[0\.06em\]/);
  });
});
