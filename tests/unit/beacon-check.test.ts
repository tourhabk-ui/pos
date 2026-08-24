/**
 * Проба записи маяка: ничего не пишет и ничего не выдумывает.
 *
 * Сторожит три свойства, без которых проба вредна:
 *   - откат гарантирован (иначе диагностика подделывает касание туриста);
 *   - INSERT дословно тот же, что у приёмника (иначе проба проверяет не то);
 *   - отказ назван отказом, а не «запись работает».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECK    = readFileSync(join(process.cwd(), 'app/api/cron/beacon-check/route.ts'), 'utf-8');
const RECEIVER = readFileSync(join(process.cwd(), 'app/api/funnel/route.ts'), 'utf-8');

/** Скелет SQL: без пробелов и переносов — сравниваем смысл, не отступы. */
function skeleton(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('проба записи маяка не оставляет следов', () => {
  it('откат в finally — случается и на успехе тоже', () => {
    expect(CHECK).toMatch(/finally\s*\{[\s\S]*ROLLBACK/);
  });

  it('COMMIT не встречается вовсе', () => {
    expect(CHECK).not.toContain('COMMIT');
  });

  it('отказ отката сам пишется в лог, а не глотается', () => {
    expect(CHECK).toMatch(/ROLLBACK'\)\.catch\(\(err\) => \{[\s\S]*console\.error/);
  });

  it('подставные значения опознаваемы как проба, если откат вдруг не сработал', () => {
    expect(CHECK).toContain('beacon-check-rollback');
  });
});

describe('проба проверяет НАСТОЯЩИЙ путь записи', () => {
  it('её INSERT совпадает с INSERT приёмника', () => {
    const takeInsert = (src: string) => {
      const m = src.match(/INSERT INTO funnel_events[\s\S]*?\)`/);
      expect(m, 'INSERT не найден').not.toBeNull();
      return skeleton((m as RegExpMatchArray)[0].replace(/`$/, ''));
    };
    expect(takeInsert(CHECK)).toBe(takeInsert(RECEIVER));
  });
});

describe('зелёный ответ не читается шире, чем он есть', () => {
  it('сказано, что проба доказывает и чего не доказывает', () => {
    expect(CHECK).toContain('proves');
    expect(CHECK).toContain('does_not_prove');
  });

  it('отказ пула — это failed, а не молчаливый успех', () => {
    expect(CHECK).toMatch(/write_path: 'failed'[\s\S]*не удалось взять соединение/);
  });

  it('write_path начинается с failed: успех надо доказать, а не предположить', () => {
    expect(CHECK).toMatch(/let writePath: 'ok' \| 'failed' = 'failed';/);
  });
});

describe('приёмник маяка больше не теряет события молча', () => {
  it('пустого catch в приёмнике нет', () => {
    expect(RECEIVER).not.toMatch(/\} catch \{ \/\* маяк не должен отдавать 500/);
  });

  it('отказ записи пишется в лог: шаг, сообщение, SQLSTATE', () => {
    expect(RECEIVER).toMatch(/console\.error\(\s*`\[funnel\] событие/);
    expect(RECEIVER).toContain('SQLSTATE=');
  });

  it('витрине по-прежнему 204: маяк не роняет страницу', () => {
    expect(RECEIVER).toMatch(/return new NextResponse\(null, \{ status: 204 \}\);\s*\}\s*$/);
  });
});
