/**
 * Классификатор моделей для админ-дашборда «Модели эволюции»: годна ли модель
 * участвовать в эволюции и почему нет. Согласован с pickBestModel (тот же EXCLUDE).
 */
import { describe, it, expect } from 'vitest';
import { classifyModel, classifyModels } from '@/lib/ai/model-resolver';

describe('classifyModel', () => {
  it('общая модель — годна, с весом', () => {
    const r = classifyModel('qwen-max-latest');
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.score).toBeGreaterThan(0);
  });

  it('reasoner — отсеяна с причиной про JSON', () => {
    const r = classifyModel('deepseek-reasoner');
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/JSON/i);
  });

  it('мультимодальная — отсеяна', () => {
    expect(classifyModel('qwen-vl-max').eligible).toBe(false);
    expect(classifyModel('qwen-audio').eligible).toBe(false);
  });

  it('эмбеддинги — отсеяны', () => {
    expect(classifyModel('text-embedding-v3').eligible).toBe(false);
    expect(classifyModel('text-embedding-v3').reason).toMatch(/эмбед/i);
  });

  it('пустой id — не годен', () => {
    expect(classifyModel('').eligible).toBe(false);
  });
});

describe('classifyModels — сортировка', () => {
  it('годные впереди по убыванию силы, отсеянные — в конце', () => {
    const out = classifyModels(['deepseek-reasoner', 'qwen-plus', 'qwen-max', 'qwen-embedding']);
    // первые две — годные (max сильнее plus), последние — отсеянные
    expect(out[0].id).toBe('qwen-max');
    expect(out[0].eligible).toBe(true);
    expect(out[1].id).toBe('qwen-plus');
    expect(out[out.length - 1].eligible).toBe(false);
  });
});
