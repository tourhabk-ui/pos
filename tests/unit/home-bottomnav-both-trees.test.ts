/**
 * Единая мобильная навигация (§2) обязана быть на публичной главной в ОБОИХ
 * серверных деревьях — не только в том, что выбрала UA-эвристика.
 *
 * Issue #1839: `app/page.tsx` рендерит одно из двух деревьев по User-Agent —
 * мобильное (HomeV8Client, уже несёт BottomNav) и «десктопное», на которое
 * попадает не только настоящий десктоп, но и любой UA, который эвристика не
 * распознала как телефон («неоднозначный UA → десктоп, безопасный дефолт»).
 * До правки десктопное дерево не рендерило BottomNav вовсе — значит §2
 * держался только там, где UA-строка распозналась правильно, а не «на всех
 * экранах», как обещано.
 *
 * BottomNav сам решает видимость через CSS `md:hidden` (тот же приём, что в
 * HubLayout) — рендерить его в десктопном дереве безусловно можно и нужно,
 * второй UA-проверки не требуется.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf-8');
const HOME_V8 = readFileSync(join(process.cwd(), 'app/_home/_HomeV8Client.tsx'), 'utf-8');

describe('BottomNav на публичной главной — в обоих деревьях', () => {
  it('импортирует единый BottomNav платформы', () => {
    expect(PAGE).toContain("import BottomNav from '@/components/shared/BottomNav'");
  });

  it('десктопное дерево рендерит BottomNav (не только мобильное через HomeV8Client)', () => {
    const desktopTreeStart = PAGE.indexOf('Десктоп-дерево');
    expect(desktopTreeStart, 'комментарий десктоп-дерева не найден — разметка page.tsx изменилась').toBeGreaterThan(-1);
    const desktopTree = PAGE.slice(desktopTreeStart);
    expect(desktopTree).toContain('<BottomNav activePath="/" />');
  });

  it('мобильное дерево (HomeV8Client) по-прежнему несёт BottomNav', () => {
    expect(HOME_V8).toContain('<BottomNav activePath="/" />');
  });

  it('BottomNav сам скрывает себя на десктопных ширинах — двойного UA-гейта в page.tsx не нужно', () => {
    const bottomNav = readFileSync(join(process.cwd(), 'components/shared/BottomNav.tsx'), 'utf-8');
    expect(bottomNav).toMatch(/md:hidden/);
  });
});
