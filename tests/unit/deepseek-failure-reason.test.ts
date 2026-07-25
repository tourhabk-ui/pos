/**
 * Алерт про DeepSeek обязан называть причину.
 *
 * 25.07 дважды пришло «WARN: DeepSeek недоступен» — и всё. По этому тексту не
 * отличить «ключ не задан на Timeweb» от «402, кончился баланс» и от
 * «сеть/таймаут». У соседей по водопаду диагностика была
 * (probeOpenRouterKeyStatus, probeQwenKeyStatus), а у первичного решателя
 * эволюции (CLAUDE.md §8) — нет.
 */
import { describe, it, expect } from 'vitest';
import { explainDeepSeekFailure } from '@/lib/ai/providers';

describe('explainDeepSeekFailure', () => {
  it('ключ не задан — это настройка, а не сбой провайдера', () => {
    expect(explainDeepSeekFailure({ key_set: false, http_status: null, detail: 'ключ не задан' }))
      .toContain('DEEPSEEK_API_KEY');
  });

  it('401/403 — ключ отвергнут', () => {
    expect(explainDeepSeekFailure({ key_set: true, http_status: 401, detail: '' })).toContain('отвергнут');
    expect(explainDeepSeekFailure({ key_set: true, http_status: 403, detail: '' })).toContain('отвергнут');
  });

  it('402 — баланс, самая частая причина тихой смерти', () => {
    expect(explainDeepSeekFailure({ key_set: true, http_status: 402, detail: '' })).toContain('баланс');
  });

  it('429 — лимит запросов', () => {
    expect(explainDeepSeekFailure({ key_set: true, http_status: 429, detail: '' })).toContain('лимит');
  });

  it('5xx — сбой на стороне провайдера, а не наш', () => {
    expect(explainDeepSeekFailure({ key_set: true, http_status: 503, detail: '' })).toContain('DeepSeek');
  });

  it('сеть/таймаут — отдаём текст ошибки как есть', () => {
    expect(explainDeepSeekFailure({ key_set: true, http_status: null, detail: 'сеть/timeout: aborted' }))
      .toBe('сеть/timeout: aborted');
  });

  it('неожиданный код не теряется: виден статус и тело', () => {
    const out = explainDeepSeekFailure({ key_set: true, http_status: 418, detail: 'teapot' });
    expect(out).toContain('418');
    expect(out).toContain('teapot');
  });
});
