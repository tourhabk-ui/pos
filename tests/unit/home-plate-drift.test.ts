/**
 * Лента туров на главной плывёт справа налево (решение владельца 04.10),
 * и при этом не возвращает причину, по которой аудит 24.09 (#42, WCAG 2.2.2)
 * снимал автопрокрутку: прыжков нет, под пальцем стоит, есть кнопка
 * остановки, reduced-motion — без движения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrapDrift, DRIFT_PX_PER_SEC, RESUME_AFTER_MS } from '@/hooks/use-plate-drift';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const HOOK = read('hooks/use-plate-drift.ts');
const HOME = read('app/_home/_HomeV8Client.tsx');

describe('дрейф', () => {
  it('медленный и непрерывный: карточка в ~300 px идёт больше 10 секунд', () => {
    expect(DRIFT_PX_PER_SEC).toBeGreaterThan(0);
    expect(300 / DRIFT_PX_PER_SEC).toBeGreaterThan(10);
    expect(HOOK).toContain('requestAnimationFrame');
    expect(HOOK).not.toMatch(/setInterval\(/);
  });

  it('справа налево: позиция прокрутки только растёт и заворачивается в петлю', () => {
    expect(HOOK).toMatch(/pos \+ \(DRIFT_PX_PER_SEC \* dt\) \/ 1000/);
    expect(wrapDrift(1005, 1000)).toBe(5);
    expect(wrapDrift(999, 1000)).toBe(999);
    expect(wrapDrift(-3, 1000)).toBe(997);
    expect(wrapDrift(42, 0)).toBe(42);
  });

  it('под пальцем, мышью и фокусом стоит, отпустили — ждёт', () => {
    for (const ev of ['pointerdown', 'touchstart', 'wheel', 'focusin', 'mouseenter']) {
      expect(HOOK).toContain(`'${ev}'`);
    }
    expect(RESUME_AFTER_MS).toBeGreaterThanOrEqual(3000);
  });

  it('reduced-motion — без движения; фоновая вкладка — тоже', () => {
    expect(HOOK).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(HOOK).toContain('document.hidden');
  });

  it('кнопка остановки есть и озвучена (WCAG 2.2.2)', () => {
    expect(HOME).toContain('onClick={drift.toggle}');
    expect(HOME).toContain("'Остановить ленту туров'");
  });

  it('копия для петли скрыта от чтения и клавиатуры', () => {
    expect(HOME).toContain('aria-hidden={clone || undefined}');
    expect(HOME).toContain('tabIndex={clone ? -1 : undefined}');
    expect(HOME).toContain('setPlateIdx(best % tours.length)');
  });
});
