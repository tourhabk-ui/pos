/**
 * Перечень доступных моделей — обещания диагностики.
 *
 * Роут отвечает на вопрос «какую модель поставить в override», и врать ему
 * особенно нельзя: пустой список читается как «моделей нет» и уводит чинить
 * не то, а значение override может оказаться секретом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/ai-models/route.ts'), 'utf-8');
const LIB = readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8');

describe('перечень моделей провайдера', () => {
  it('не смог спросить и «моделей нет» — разные ответы', () => {
    // Отдельное поле для отказа, а не пустой массив.
    expect(SRC).toContain('list_failed');
    expect(SRC).toMatch(/available:\s*listed\.ok \? listed\.ids : null/);
    // Источник отличимого отказа — отдельная функция, а не снисходительный
    // getProviderModelIds, который глотает ошибку ради живого пути.
    expect(SRC).toContain('probeProviderModels');
    expect(LIB).toMatch(/export async function probeProviderModels/);
    expect(LIB).toMatch(/ok:\s*false;\s*http_status: number \| null/);
  });

  it('значения env не печатаются — только имя и факт наличия', () => {
    expect(SRC).toMatch(/set: Boolean\(process\.env\[env\]\)/);
    // Ни одного места, где значение переменной уходит в ответ.
    expect(SRC, 'значение override может быть секретом')
      .not.toMatch(/value:\s*process\.env/);
    expect(SRC).not.toMatch(/process\.env\[env\]\s*\}/);
  });

  it('ничего не пишет', () => {
    expect(SRC).not.toMatch(/INSERT|UPDATE|DELETE|pool\.query/);
  });

  it('различает конфиг и то, что выберет резолвер', () => {
    // Именно это расхождение объясняет «диагностика красная, путь зелёный».
    expect(SRC).toContain('configured');
    expect(SRC).toContain('resolved');
    expect(SRC).toMatch(/resolveChatModel|resolveContentModel|resolveDecisionModel/);
  });

  it('закрыт CRON_SECRET', () => {
    expect(SRC).toContain('timingSafeCompare');
    expect(SRC).toContain('CRON_SECRET');
  });
});
