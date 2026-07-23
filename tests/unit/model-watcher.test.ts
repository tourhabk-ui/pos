/**
 * Model-watcher: заводить находку только когда есть baseline И новый кандидат
 * СТРОГО сильнее. Первый прогон (нет baseline) — молча, только точка отсчёта.
 */
import { describe, it, expect } from 'vitest';
import { isStrongerModel } from '@/lib/agents/evo/model-watcher';
import { scoreModel } from '@/lib/ai/model-resolver';

describe('isStrongerModel', () => {
  it('нет baseline (первый прогон) → false', () => {
    expect(isStrongerModel('qwen-max-latest', null)).toBe(false);
  });

  it('нет кандидата → false', () => {
    expect(isStrongerModel(null, { id: 'qwen-plus', score: scoreModel('qwen-plus') })).toBe(false);
  });

  it('та же модель → false', () => {
    expect(isStrongerModel('deepseek-chat', { id: 'deepseek-chat', score: scoreModel('deepseek-chat') })).toBe(false);
  });

  it('новый кандидат строго сильнее → true', () => {
    // qwen-max сильнее qwen-plus по тиру
    expect(isStrongerModel('qwen-max', { id: 'qwen-plus', score: scoreModel('qwen-plus') })).toBe(true);
  });

  it('новый кандидат слабее/равен → false', () => {
    expect(isStrongerModel('qwen-plus', { id: 'qwen-max', score: scoreModel('qwen-max') })).toBe(false);
  });

  it('устаревший stored.score (0) — любой валидный кандидат считается сильнее', () => {
    expect(isStrongerModel('deepseek-chat', { id: 'old-model', score: 0 })).toBe(true);
  });
});
