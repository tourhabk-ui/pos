/**
 * Выбор модели-решателя БЕЗ привязки к id. Ранкер должен сам находить
 * сильнейшую ОБЩУЮ модель в списке /v1/models и НЕ выбирать классы, ломающие
 * решателя (reasoner → <think>-теги рвут JSON; мультимодальные/служебные).
 */
import { describe, it, expect } from 'vitest';
import { pickBestModel, scoreModel } from '@/lib/ai/model-resolver';

describe('pickBestModel — DeepSeek', () => {
  it('предпочитает флагманский general (chat-алиас) reasoner-у', () => {
    expect(pickBestModel(['deepseek-chat', 'deepseek-reasoner'])).toBe('deepseek-chat');
  });
  it('reasoner/thinking исключены совсем', () => {
    expect(pickBestModel(['deepseek-reasoner', 'deepseek-r1'])).toBeNull();
  });
  it('chat-алиас предпочтительнее датированного снапшота (годы не считаем версией)', () => {
    expect(pickBestModel(['deepseek-chat', 'deepseek-chat-2025-01-25'])).toBe('deepseek-chat');
  });
});

describe('pickBestModel — Qwen', () => {
  it('max-тир выигрывает у plus/turbo', () => {
    expect(pickBestModel(['qwen-turbo', 'qwen-plus', 'qwen-max-latest'])).toBe('qwen-max-latest');
  });
  it('скользящий -latest предпочтительнее закреплённого снапшота той же силы', () => {
    expect(pickBestModel(['qwen-max-latest', 'qwen-max-2025-01-25'])).toBe('qwen-max-latest');
  });
  it('новая линейка (qwen3-max) выигрывает у старой (qwen2.5-max) при отсутствии -latest', () => {
    expect(pickBestModel(['qwen2.5-max', 'qwen3-max'])).toBe('qwen3-max');
  });
  it('мультимодальные и служебные исключены', () => {
    expect(pickBestModel(['qwen-vl-max', 'qwen-audio', 'qwen-max'])).toBe('qwen-max');
    expect(pickBestModel(['text-embedding-v3', 'qwen-vl-plus'])).toBeNull();
  });
});

describe('pickBestModel — устойчивость', () => {
  it('пустой список / только исключённые → null', () => {
    expect(pickBestModel([])).toBeNull();
    expect(pickBestModel(['qwen-embedding', 'bge-reranker'])).toBeNull();
  });
  it('детерминизм: при равенстве баллов — стабильный выбор', () => {
    const a = pickBestModel(['model-a-max', 'model-b-max']);
    const b = pickBestModel(['model-b-max', 'model-a-max']);
    expect(a).toBe(b);
  });
  it('scoreModel: max > pro > plus/chat > turbo/flash', () => {
    expect(scoreModel('x-max')).toBeGreaterThan(scoreModel('x-pro'));
    expect(scoreModel('x-pro')).toBeGreaterThan(scoreModel('x-plus'));
    expect(scoreModel('x-plus')).toBeGreaterThan(scoreModel('x-turbo'));
  });
});
