/**
 * Шлюз Timeweb к флагманам — БЕЗ хопа за границей (CLAUDE.md §8, замер 23.08).
 *
 * У шлюза модель — свойство АГЕНТА (URL несёт agent_id, `/v1/models` у него
 * нет), поэтому вместо авто-резолва по каталогу (как у DeepSeek/Qwen) — явная
 * карта «имя модели → агент» из env (`TIMEWEB_AI_AGENTS`), которую владелец
 * наполняет сам, создавая агентов в панели Timeweb. Не задана/битый JSON →
 * пустая карта → ступень решателя молча пропускается, как и остальные
 * провайдеры без ключа (тот же fail-soft контракт по всему файлу).
 *
 * Два дефекта, которые эта ступень могла бы внести молча, если бы их не
 * поймать здесь: (1) модель, прошедшая через шлюз, помечена строкой вида
 * `timeweb:<имя>` — если `isFlagshipDecision`/`flagshipSteps` в alert.ts не
 * знают этот префикс, аудит, реально посчитанный флагманом, попадёт в отчёт
 * как «понижение до фоллбэка»; (2) шаг решателя обязан идти ПЕРВЫМ (до
 * OpenRouter/Anthropic-релея) — в этом весь смысл: у него нет стороннего
 * релея и, значит, нет его гео-блока.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTimewebAgents } from '@/lib/ai/provider-config';
import { isFlagshipDecision } from '@/lib/agents/evo/alert';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('getTimewebAgents: парсинг TIMEWEB_AI_AGENTS', () => {
  const ORIGINAL = process.env.TIMEWEB_AI_AGENTS;

  beforeEach(() => { delete process.env.TIMEWEB_AI_AGENTS; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TIMEWEB_AI_AGENTS;
    else process.env.TIMEWEB_AI_AGENTS = ORIGINAL;
  });

  it('переменная не задана — пустая карта', () => {
    expect(getTimewebAgents()).toEqual({});
  });

  it('валидный JSON — карта распознана', () => {
    process.env.TIMEWEB_AI_AGENTS = JSON.stringify({
      'claude-opus-5': { agentId: 'agt-1', token: 'tok-1' },
      'gpt-5.6': { agentId: 'agt-2', token: 'tok-2' },
    });
    const agents = getTimewebAgents();
    expect(agents['claude-opus-5']).toEqual({ agentId: 'agt-1', token: 'tok-1' });
    expect(agents['gpt-5.6']).toEqual({ agentId: 'agt-2', token: 'tok-2' });
  });

  it('битый JSON — пустая карта, не исключение', () => {
    process.env.TIMEWEB_AI_AGENTS = '{не json';
    expect(getTimewebAgents()).toEqual({});
  });

  it('запись без agentId/token отбрасывается, валидные соседи остаются', () => {
    process.env.TIMEWEB_AI_AGENTS = JSON.stringify({
      good: { agentId: 'agt-1', token: 'tok-1' },
      bad: { agentId: 'agt-2' },
      empty: { agentId: '  ', token: 'tok-3' },
    });
    expect(Object.keys(getTimewebAgents())).toEqual(['good']);
  });

  it('массив вместо объекта — пустая карта', () => {
    process.env.TIMEWEB_AI_AGENTS = '["not", "an", "object"]';
    expect(getTimewebAgents()).toEqual({});
  });
});

describe('решатель: шаг Timeweb — первый и fail-soft', () => {
  const src = read('lib/ai/providers.ts');
  const decider = src.match(/export async function callAIDecisionDetailed[\s\S]*?\n\}/)?.[0] ?? '';

  it('тело функции найдено', () => {
    expect(decider.length).toBeGreaterThan(500);
  });

  it('шаг Timeweb стоит ДО шага OpenRouter-релея', () => {
    const timewebAt = decider.indexOf('getTimewebAgents()');
    const openrouterAt = decider.indexOf('OPENROUTER_API_KEY не задан');
    expect(timewebAt).toBeGreaterThan(-1);
    expect(openrouterAt).toBeGreaterThan(-1);
    expect(timewebAt).toBeLessThan(openrouterAt);
  });

  it('нет агентов — причина пишется в provenance, решатель не падает', () => {
    expect(decider).toMatch(/why\.push\('timeweb: TIMEWEB_AI_AGENTS не задан'\)/);
  });

  it('ответ шлюза атрибутируется строкой timeweb:<имя>', () => {
    expect(decider).toMatch(/model: `timeweb:\$\{bestName\}`/);
  });

  it('сильнейший из настроенных агентов выбирается тем же ранжировщиком, что и остальные флагманские каталоги', () => {
    expect(decider).toMatch(/pickBestFlagship\(timewebNames\)/);
  });
});

describe('isFlagshipDecision: шлюз Timeweb — тоже флагман, не понижение', () => {
  it('модель через timeweb: считается флагманом', () => {
    expect(isFlagshipDecision('timeweb:claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('timeweb:gpt-5.6')).toBe(true);
  });

  it('прежние формы не сломаны', () => {
    expect(isFlagshipDecision('anthropic:claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('anthropic/claude-opus-5')).toBe(true);
    expect(isFlagshipDecision('deepseek-chat')).toBe(false);
  });
});

describe('D2: agent.timeweb.cloud зарегистрирован', () => {
  it('хост есть в замороженном реестре с domestic:false', () => {
    const registry = read('lib/agents/compliance/provider-registry.ts');
    expect(registry).toMatch(/host: 'agent\.timeweb\.cloud'/);
    expect(registry).toMatch(/host: 'agent\.timeweb\.cloud'[\s\S]{0,20}jurisdiction:[\s\S]{0,80}domestic: false/);
  });

  it('сканер хостов распознаёт timeweb — не проходит мимо D2 молча', () => {
    const registry = read('lib/agents/compliance/provider-registry.ts');
    const re = registry.match(/if \(\/([^/]+)\/\.test\(host\)\)/)?.[1] ?? '';
    expect(re).toMatch(/timeweb/);
  });
});
