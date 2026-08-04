/**
 * Сторож на сам токен-гейт.
 *
 * Гейт (`scripts/design-token-gate.mjs`) рендерит страницы и сверяет палитру с
 * токенами `app/globals.css`; исключения живут в allowlist и не красят прогон.
 * Ровно поэтому у него два способа тихо выродиться:
 *  · allowlist разрастается записями без причины — и «исключение» перестаёт
 *    отличаться от «забыли»;
 *  · токены перестают вычитываться из globals.css (переезд файла, свой список
 *    в скрипте) — тогда нарушением становится всё или ничего.
 * Здесь проверяется то, что можно проверить без запущенного приложения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const GATE = read('scripts/design-token-gate.mjs');
const ALLOWLIST = JSON.parse(read('scripts/design-token-gate.allowlist.json')) as {
  colors: Record<string, string>;
};
const WORKFLOW = read('.github/workflows/design-token-gate.yml');

describe('токен-гейт: источник истины — globals.css', () => {
  it('токены читаются из globals.css, а не перечислены в скрипте', () => {
    expect(GATE).toMatch(/app\/globals\.css/);
    // Свой список hex в скрипте означал бы вторую дизайн-систему.
    const literals = GATE.match(/'#[0-9a-fA-F]{6}'/g) ?? [];
    const neutral = new Set(["'#ffffff'", "'#000000'"]);
    expect(literals.filter((h) => !neutral.has(h.toLowerCase()))).toEqual([]);
  });

  it('нарушение красит прогон, а не только печатается', () => {
    expect(GATE).toMatch(/process\.exit\(1\)/);
  });

  it('недоступное приложение — не зелёный вердикт', () => {
    // Молча зелёный гейт хуже отсутствующего: он создаёт ложную уверенность.
    expect(GATE).toMatch(/process\.exit\(2\)/);
  });

  it('версия извлекателя закреплена', () => {
    expect(GATE).toMatch(/dembrandt@\d+\.\d+\.\d+/);
  });
});

describe('allowlist: исключение с причиной, а не свалка', () => {
  it('у каждого цвета есть внятная причина', () => {
    const entries = Object.entries(ALLOWLIST.colors);
    expect(entries.length).toBeGreaterThan(0);
    for (const [color, reason] of entries) {
      expect(color, `${color}: не нормализованный hex`).toMatch(/^#[0-9a-f]{6}$/);
      expect(reason.trim().length, `${color}: причина пустая`).toBeGreaterThan(20);
    }
  });

  it('в исключения не попал документированный токен', () => {
    // Токен в allowlist — признак того, что список перестали читать.
    const css = read('app/globals.css');
    const tokens = new Set((css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()));
    for (const color of Object.keys(ALLOWLIST.colors)) {
      expect(tokens.has(color), `${color} есть в globals.css — исключение лишнее`).toBe(false);
    }
  });
});

describe('гейт действительно запускается', () => {
  it('workflow зовёт скрипт и ставит браузер под закреплённую версию', () => {
    expect(WORKFLOW).toMatch(/node scripts\/design-token-gate\.mjs/);
    const pinned = GATE.match(/dembrandt@(\d+\.\d+\.\d+)/)?.[1];
    expect(pinned).toBeTruthy();
    expect(WORKFLOW).toMatch(/playwright@\d+\.\d+\.\d+ install/);
  });

  it('локальный запуск есть в npm-скриптах', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['design:tokens']).toMatch(/design-token-gate\.mjs/);
  });
});
