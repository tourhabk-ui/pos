/**
 * Мёртвый эндпоинт /api/tours/[id]/time-slots не возвращается (вскрытие 08.08).
 *
 * История: находка Evo (55e7c991) поймала в нём опечатку guests_count (#1007),
 * но проба прода с раннера показала правду глубже: роут ссылался на колонку
 * tour_type, которой нет ни в одной миграции, — 500 для ЛЮБОГО тура, всегда.
 * При этом его не вызывал ни один компонент: живой флоу дат брони — это
 * /api/tours/[id]/slots (стандарт карточки §11 CLAUDE.md; проба 31232781541 —
 * 0 ошибок на 60 id, реальные даты у восьми туров).
 *
 * Урок: чинили комнату в доме без фундамента. Роут удалён; сторож держит две
 * границы — файл не возрождается и никто не начинает звать умерший путь.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

describe('мёртвый /time-slots удалён и не возвращается', () => {
  it('файла роута нет', () => {
    expect(existsSync(join(ROOT, 'app/api/tours/[id]/time-slots/route.ts'))).toBe(false);
  });

  it('ни один компонент/модуль не зовёт /time-slots', () => {
    const out = execSync(
      `grep -rl "time-slots" app components lib --include='*.ts' --include='*.tsx' || true`,
      { cwd: ROOT, encoding: 'utf-8' },
    ).trim();
    expect(out, `появились ссылки на мёртвый путь: ${out}`).toBe('');
  });

  it('живой эндпоинт дат /slots на месте и считает по реальным колонкам', () => {
    const src = readFileSync(join(ROOT, 'app/api/tours/[id]/slots/route.ts'), 'utf-8');
    expect(src).toMatch(/SUM\(ob\.participants\)/);
    expect(src).not.toMatch(/guests_count|tour_type/);
  });
});
