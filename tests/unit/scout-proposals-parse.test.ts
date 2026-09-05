import { describe, it, expect, vi } from 'vitest';

// scout-innovator тянет провайдеров на импорте — мокаем, тестируем чистую функцию.
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: vi.fn(),
  callAIWithModel: vi.fn(),
  callAIWaterfall: vi.fn(),
  callAIWaterfallOrNull: vi.fn(),
  callQwen: vi.fn(),
  // Разбор опознаёт заглушку водопада как «не ответил ни один провайдер»
  // (04.09), поэтому мок обязан отдавать и её распознаватель — иначе тест
  // проверяет не тот код, что работает на проде.
  isWaterfallErrorResponse: (t: string) => t.startsWith('Извините, сервис временно недоступен')
    || t.startsWith('Сервис временно недоступен'),
}));

import { parseProposalsResponse, salvageTruncatedArray } from '@/lib/agents/scout-innovator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INNOVATOR = readFileSync(join(process.cwd(), 'lib/agents/scout-innovator.ts'), 'utf-8');
const PROVIDERS = readFileSync(join(process.cwd(), 'lib/ai/providers.ts'), 'utf-8');

describe('оборванный по потолку токенов массив (прогон 389, 05.09)', () => {
  const full = '{"title":"A","why":"w","files_to_change":["lib/a.ts"],"implementation_steps":["1"],"acceptance_criteria":["ok"],"complexity":"small","category":"fix"}';
  const truncated = `[${full},${full.replace('"A"', '"B"')},{"title":"C","why":"обры`;

  it('целые предложения спасаются, недописанное — нет', () => {
    const { proposals, diag } = parseProposalsResponse(truncated);
    expect(proposals).toHaveLength(2);
    expect(proposals.map(p => p.title)).toEqual(['A', 'B']);
    expect(diag).toMatch(/оборван/);
    expect(diag).toMatch(/спасено целых предложений: 2/);
  });

  it('фигурные скобки и кавычки внутри строк не путают счёт', () => {
    const tricky = '[{"title":"скобка } в строке","why":"кавычка \\" тоже"},{"title":"недо';
    expect(salvageTruncatedArray(tricky)).toHaveLength(1);
  });

  it('если целых нет — прежний диагноз про parse, без спасённых', () => {
    const { proposals, diag } = parseProposalsResponse('[{"title": broken}]');
    expect(proposals).toHaveLength(0);
    expect(diag).toMatch(/JSON\.parse упал/);
  });

  it('потолок токенов у Qwen поднят явно, а не остался чатовым 800', () => {
    // Обрыв на позиции ~2440 — это 800 токенов кириллического JSON.
    expect(INNOVATOR).toMatch(/callQwen\(messages, \{ maxTokens: \d{4} \}\)/);
    expect(PROVIDERS).toMatch(/max_tokens: maxTokens/);
  });
});

describe('parseProposalsResponse', () => {
  const one = '[{"title":"T","why":"w","files_to_change":["lib/a.ts"],"implementation_steps":["1"],"acceptance_criteria":["ok"],"complexity":"small","category":"fix"}]';

  it('чистый JSON-массив — распознаётся', () => {
    const { proposals, diag } = parseProposalsResponse(one);
    expect(proposals).toHaveLength(1);
    expect(diag).toContain('распознано предложений: 1');
  });

  it('JSON в markdown-фенсе ```json — распознаётся', () => {
    const { proposals } = parseProposalsResponse('```json\n' + one + '\n```');
    expect(proposals).toHaveLength(1);
  });

  it('JSON внутри prose — вытягивается массив', () => {
    const { proposals } = parseProposalsResponse(`Вот предложения:\n${one}\nНадеюсь, помог.`);
    expect(proposals).toHaveLength(1);
  });

  it('пустая строка (waterfall исчерпан) — [] + внятный diag', () => {
    const { proposals, diag } = parseProposalsResponse('');
    expect(proposals).toHaveLength(0);
    expect(diag).toMatch(/пустую строку/);
  });

  it('prose без массива — [] + diag с головой ответа', () => {
    const { proposals, diag } = parseProposalsResponse('Извините, не могу помочь.');
    expect(proposals).toHaveLength(0);
    expect(diag).toMatch(/нет JSON-массива/);
  });

  it('осознанный пустой массив — [] + отдельный diag', () => {
    const { proposals, diag } = parseProposalsResponse('[]');
    expect(proposals).toHaveLength(0);
    expect(diag).toMatch(/пустой массив/);
  });

  it('битый JSON — [] + diag про parse', () => {
    const { proposals, diag } = parseProposalsResponse('[{"title": broken}]');
    expect(proposals).toHaveLength(0);
    expect(diag).toMatch(/JSON\.parse упал/);
  });
});
