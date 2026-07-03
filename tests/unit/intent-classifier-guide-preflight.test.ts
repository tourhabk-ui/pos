import { describe, it, expect } from 'vitest';
import { classifyIntentByKeywords } from '@/lib/agents/intent-classifier';

describe('classifyIntentByKeywords — guide_route_preflight (issue #248)', () => {
  it('classifies "проверь маршрут X" as guide_route_preflight', () => {
    // Имя маршрута намеренно без слов вроде "вулкан"/"рыбалка" — это уже
    // самостоятельные ключевые слова tourist_recommend, объявленного раньше
    // в keyword-map, и классификатор — first-match-wins по substring.
    expect(classifyIntentByKeywords('проверь маршрут Ганальские Востряки')).toBe('guide_route_preflight');
  });

  it('classifies "предполётная проверка" as guide_route_preflight', () => {
    expect(classifyIntentByKeywords('предполётная проверка Мутновского')).toBe('guide_route_preflight');
  });

  it('still classifies unrelated guide commands as before', () => {
    expect(classifyIntentByKeywords('мои группы')).toBe('guide_groups');
    expect(classifyIntentByKeywords('статус гида')).toBe('guide_status');
  });
});
