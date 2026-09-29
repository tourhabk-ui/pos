/**
 * Значения из запроса попадают в лог без переводов строки (CodeQL
 * js/log-injection, PR #2109, 29.09).
 *
 * Имя инструмента из тела запроса MCP печаталось в лог как есть: «\n[mcp] ...»
 * подделывал бы следующую строку лога. Сторож держит обе половины: помощник
 * режет переводы строки, и каждый console.error на пути MCP с именем
 * инструмента или текстом исключения идёт через него.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { logText } from '@/lib/log/log-text';

describe('logText', () => {
  it('переводы строки и разделители строк — пробел, длина ограничена', () => {
    expect(logText('get_weather\n[mcp] подделка\r\u2028x')).toBe('get_weather [mcp] подделка x');
    expect(logText('a'.repeat(500)).length).toBe(120);
    expect(logText(undefined)).toBe('');
  });
});

describe('console.error на пути MCP — через logText', () => {
  for (const f of ['app/api/mcp/route.ts', 'lib/kuzmich/core.ts', 'lib/mcp/log-failure.ts']) {
    it(f, () => {
      const src = readFileSync(f, 'utf-8');
      const calls = [...src.matchAll(/console\.error\(([\s\S]*?)\);/g)].map((m) => m[1]!);
      // Голый аргумент — имя инструмента или текст исключения без logText.
      // Каждый аргумент судится отдельно: logText у соседнего не спасает.
      const risky = calls.filter((c) =>
        /,\s*(toolName|name)\s*[,)]/.test(c)
        || /,\s*(toolErr|err) instanceof Error \? (toolErr|err)\.message : String\((toolErr|err)\)/.test(c));
      // Только строки проверки MCP; прочие console.error в core.ts имени
      // инструмента и текста исключения не печатают — иначе сюда.
      expect(risky.filter((c) => /toolName|toolErr|kuzmich-tool|\[mcp\]/.test(c))).toEqual([]);
    });
  }
});
