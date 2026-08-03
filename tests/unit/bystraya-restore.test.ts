/**
 * Сторож миграции 810: тур сплава по Быстрой не может остаться 404.
 *
 * Повод: /catalog/tours/27 отдал «Тур не найден». Тур был скрыт (is_active=false)
 * миграцией 807 — она прячет туры, чей оператор не один из двух партнёров, а
 * перепривязать тур должна была 806. Если 806 упала целиком (в ней есть INSERT
 * INTO partners, а таблица создана до системы миграций — её NOT NULL-колонки
 * неизвестны), тур остался на демо-операторе и был погашен.
 *
 * 810 обязана: не вставлять ничего, вернуть в витрину РОВНО ОДИН тур (иначе
 * воскреснет дубль) и делать это безусловно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(process.cwd(), 'migrations/810_bystraya_restore_visibility.sql'),
  'utf-8',
);

describe('миграция 810 — тур сплава возвращается в витрину', () => {
  it('НЕ вставляет строк: только UPDATE (INSERT мог уронить весь файл)', () => {
    // Комментарии отбрасываем — в них INSERT упоминается как объяснение причины.
    const sqlOnly = src
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n');
    expect(sqlOnly).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sqlOnly).toMatch(/\bUPDATE\b/i);
  });

  it('возвращает тур в витрину: is_active, is_published, снятие deleted_at', () => {
    expect(src).toMatch(/is_active\s*=\s*TRUE/);
    expect(src).toMatch(/is_published\s*=\s*TRUE/);
    expect(src).toMatch(/deleted_at\s*=\s*NULL/);
  });

  it('воскрешает РОВНО ОДИН тур — иначе вернётся дубль, погашенный 803/806', () => {
    expect(src).toContain('WITH canonical AS');
    expect(src).toMatch(/LIMIT 1/);
    expect(src).toMatch(/FROM canonical c/);
  });

  it('пытается привязать к настоящему партнёру-рафтингу', () => {
    expect(src).toContain("p.slug = 'kamchatka-rafting'");
  });

  it('запасной путь без INSERT: переименовать текущего владельца', () => {
    expect(src).toContain("name     = 'Камчатка Рафтинг'");
    expect(src).toContain('Катерина');
    expect(src).toContain('Ярослав');
  });

  it('идемпотентна: трогает только то, что реально расходится', () => {
    expect(src).toMatch(/IS DISTINCT FROM/);
  });
});
