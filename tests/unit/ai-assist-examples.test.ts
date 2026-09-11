/**
 * Примеры команд AI-помощника разбираются его же классификатором (#1800).
 *
 * Кнопка «Сводка туров» слала «Покажи сводку по моим турам», классификатор
 * искал «мои туры» — и не находил: экран обещал команду, которую сам же не
 * умел разобрать (правило 10.09 «объявленное без производителя»). Пример и
 * ключевая фраза теперь в одном модуле, и здесь каждый пример ПРОГОНЯЕТСЯ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_COMMAND_EXAMPLES, classifyIntentByKeywords } from '@/lib/agents/intent-classifier';
import { allowedIntentsForRole } from '@/lib/agents/permissions';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('примеры команд оператора', () => {
  it.each(OPERATOR_COMMAND_EXAMPLES)('«$label» распознаётся как $intent', ({ message, intent }) => {
    expect(classifyIntentByKeywords(message, 'operator')).toBe(intent);
  });

  it('каждое намерение примера доступно роли оператора', () => {
    const allowed = allowedIntentsForRole('operator');
    for (const ex of OPERATOR_COMMAND_EXAMPLES) {
      expect(allowed, `${ex.label} → ${ex.intent}`).toContain(ex.intent);
    }
  });

  it('экран берёт примеры из реестра, своего списка не держит', () => {
    const client = read('app/hub/operator/ai-assist/AIAssistClient.tsx');
    expect(client).toMatch(/OPERATOR_COMMAND_EXAMPLES/);
    expect(client).not.toMatch(/const EXAMPLES = \[/);
    // Перечень «Доступные команды» — из того же массива, не вторым списком.
    expect(client).toMatch(/EXAMPLES\.filter\(\(ex\) => ex\.group === group\)/);
  });
});

describe('нераспознанная команда — не отказ прав', () => {
  const route = read('app/api/agents/operator/route.ts');

  it('unknown отвечает 422 с подсказкой, а не 403 «недоступно роли»', () => {
    expect(route).toMatch(/result\.intent === 'unknown'/);
    expect(route).toMatch(/status: 422/);
    expect(route).toMatch(/Не понял команду/);
    // 403 остаётся для настоящей границы роли.
    expect(route).toMatch(/недоступно роли/);
  });

  it('подсказка берётся из того же реестра примеров', () => {
    expect(route).toMatch(/OPERATOR_COMMAND_EXAMPLES/);
  });
});
