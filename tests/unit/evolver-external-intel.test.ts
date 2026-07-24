import { describe, it, expect } from 'vitest';
import { buildEvolverPrompt } from '@/lib/agents/evo/evolver-analysis';

const STATS = [
  { action_type: 'kuzmich_chat', count: '40', error_count: '18', avg_tokens_out: '120', total_cost_usd: '0.9' },
];

describe('buildEvolverPrompt — внешняя разведка в обсуждении эволюции', () => {
  it('без разведки — прежнее поведение (нет секции)', () => {
    const p = buildEvolverPrompt(STATS, null);
    expect(p).not.toContain('ВНЕШНЯЯ РАЗВЕДКА');
    expect(p).toContain('ai_actions_log');
    expect(p).toContain('kuzmich_chat');
  });

  it('с разведкой — секция и текст дайджеста попадают в промпт', () => {
    const intel = 'HuggingFace выпустил быструю vision-модель для распознавания по фото. RATA: спрос на Камчатку +30%.';
    const p = buildEvolverPrompt(STATS, intel);
    expect(p).toContain('ВНЕШНЯЯ РАЗВЕДКА');
    expect(p).toContain('HuggingFace выпустил быструю vision-модель');
    expect(p).toContain('RATA');
    // Инструкция заводить intel-issue заземлённо
    expect(p).toContain('action_type="intel:');
    expect(p).toContain('не выдумывай');
  });

  it('длинный дайджест обрезается (защита от раздувания контекста)', () => {
    const intel = 'x'.repeat(9000);
    const p = buildEvolverPrompt(STATS, intel);
    // 5000 из дайджеста + остальной промпт — заметно меньше 9000+
    expect(p.length).toBeLessThan(8000);
    expect(p).toContain('ВНЕШНЯЯ РАЗВЕДКА');
  });
});
