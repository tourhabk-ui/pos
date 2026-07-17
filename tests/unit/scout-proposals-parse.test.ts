import { describe, it, expect, vi } from 'vitest';

// scout-innovator тянет провайдеров на импорте — мокаем, тестируем чистую функцию.
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: vi.fn(),
  callAIWithModel: vi.fn(),
  callAIWaterfall: vi.fn(),
}));

import { parseProposalsResponse } from '@/lib/agents/scout-innovator';

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
