/**
 * Dev-CSP не глушит аналитику, прод-CSP не ослаблена (задача #59,
 * находка 5 сквозного прогона 14.08).
 *
 * next dev собирает чанки через eval (eval-source-map); CSP из
 * next.config.js действует и в dev — без 'unsafe-eval' клиентский чанк с
 * PageViewTracker падал EvalError на каждой странице, и локально
 * page_views не писались вовсе: разработка была «слепа».
 *
 * Фикс — 'unsafe-eval' ТОЛЬКО при NODE_ENV=development; сторож держит обе
 * стороны: dev получает eval, прод — ни на символ не ослаблен.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = readFileSync(join(process.cwd(), 'next.config.js'), 'utf-8');
const MIDDLEWARE = readFileSync(join(process.cwd(), 'middleware.ts'), 'utf-8');

describe('unsafe-eval только в development', () => {
  it('DEV_EVAL гейтится NODE_ENV=development и пуст в production', () => {
    expect(CONFIG).toMatch(
      /const DEV_EVAL = process\.env\.NODE_ENV === 'development' \? " 'unsafe-eval'" : '';/,
    );
  });

  it('CSP-строки конфига используют DEV_EVAL, а не литеральный unsafe-eval', () => {
    // Оба CSP (widget и основной) получают eval только через гейт.
    const uses = CONFIG.match(/\$\{DEV_EVAL\}/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    // Безусловного 'unsafe-eval' внутри значений CSP нет.
    const cspValues = CONFIG.match(/Content-Security-Policy', value: [`"][^`"]+[`"]/g) ?? [];
    expect(cspValues.length).toBeGreaterThanOrEqual(2);
    for (const v of cspValues) {
      expect(v, 'unsafe-eval без гейта').not.toMatch(/'unsafe-eval'/);
    }
  });

  it('прод-CSP middleware не тронута — там unsafe-eval нет вовсе', () => {
    // middleware ставит CSP только при NODE_ENV=production (Edge-слой из
    // списка «НЕ ТРОГАТЬ» — фикс #59 его и не коснулся).
    expect(MIDDLEWARE).not.toMatch(/unsafe-eval/);
  });
});
