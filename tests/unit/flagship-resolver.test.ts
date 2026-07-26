/**
 * Авто-выбор сильнейшего флагмана (Claude/GPT) БЕЗ привязки к id.
 * Критично: эвристика не должна откатывать мозг на модель СЛАБЕЕ пина —
 * поэтому проверяем разбор версий Claude (opus-5 > opus-4-5) и лестницу тиров.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickBestFlagship, flagshipVersion } from '@/lib/ai/model-resolver';

describe('flagshipVersion — разбор версии Claude/GPT', () => {
  it('opus-5 = 5.0, opus-4-5 = 4.5 (не путать major-minor)', () => {
    expect(flagshipVersion('claude-opus-5')).toBe(5);
    expect(flagshipVersion('claude-opus-4-5')).toBe(4.5);
    expect(flagshipVersion('claude-sonnet-4-5')).toBe(4.5);
  });

  it('дата-снапшот в хвосте игнорируется', () => {
    expect(flagshipVersion('claude-opus-5-20260701')).toBe(5);
    expect(flagshipVersion('claude-opus-4-1-20250805')).toBe(4.1);
  });

  it('gpt-5 = 5.0', () => {
    expect(flagshipVersion('gpt-5')).toBe(5);
  });
});

describe('pickBestFlagship', () => {
  it('opus сильнее sonnet сильнее haiku', () => {
    const ids = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-5'];
    expect(pickBestFlagship(ids)).toBe('claude-opus-4-5');
  });

  it('при равном тире берёт старшую версию: opus-5 > opus-4-5', () => {
    expect(pickBestFlagship(['claude-opus-4-5', 'claude-opus-5'])).toBe('claude-opus-5');
    expect(pickBestFlagship(['claude-opus-4-5-20250929', 'claude-opus-5-20260701']))
      .toBe('claude-opus-5-20260701');
  });

  it('не откатывается на haiku/mini, когда есть opus', () => {
    const ids = ['claude-haiku-5', 'claude-opus-4-1', 'gpt-5-mini'];
    expect(pickBestFlagship(ids)).toBe('claude-opus-4-1');
  });

  it('фильтр семейства (каталог OpenRouter) — только anthropic/', () => {
    const ids = ['openai/gpt-5', 'anthropic/claude-opus-5', 'google/gemini-2-pro'];
    expect(pickBestFlagship(ids, 'anthropic/')).toBe('anthropic/claude-opus-5');
  });

  it('отсекает служебные (embed/vision/tts) и пустой список → null', () => {
    expect(pickBestFlagship(['claude-opus-5-vision', 'text-embedding-3'])).toBeNull();
    expect(pickBestFlagship([])).toBeNull();
  });

  it('детерминизм: при равенстве — лексикографически меньший', () => {
    const ids = ['claude-opus-5-b', 'claude-opus-5-a'];
    expect(pickBestFlagship(ids)).toBe('claude-opus-5-a');
  });
});

describe('структурно: флагман не прибит к id, идёт через резолвер', () => {
  const providers = readFileSync('lib/ai/providers.ts', 'utf8');

  it('решатель зовёт resolveFlagshipModel, а не хардкод-константу', () => {
    expect(providers).toMatch(/resolveFlagshipModel/);
    // в теле решателя используется резолвнутая модель, не старая константа
    expect(providers).not.toMatch(/EVO_FLAGSHIP_MODEL\b/);
  });

  it('пин остался только крайним фоллбэком', () => {
    expect(providers).toMatch(/EVO_FLAGSHIP_FALLBACK/);
    expect(providers).toMatch(/pickBestFlagship\(ids\)/);
  });

  it('админ-страница evo/models: pinned зависит от override, не хардкод true', () => {
    const route = readFileSync('app/api/admin/evo/models/route.ts', 'utf8');
    expect(route).toMatch(/pinned:\s*!!flagshipOverride/);
    expect(route).toMatch(/pickBestFlagship\(flagshipIds\)/);
  });
});
