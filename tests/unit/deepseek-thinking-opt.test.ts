/**
 * `callAIQuality` умеет отказаться от размышления DeepSeek (`deepThinking:
 * false`) — почему это понадобилось и что держит сторож.
 *
 * Панель 12.09 (scout-innovator): «модель=quality: ответ оборван… после
 * дедупа/критика осталось 0». История правок этого пути (см. providers.ts,
 * docstring `deepThinkingBudget`) уже поднимала maxTokens 800→3000 (05.09) —
 * не помогло: позиция обрыва сдвинулась с ~2440 до ~2527 символов, то есть
 * почти вся добавленная тысяча-другая токенов ушла в РАЗМЫШЛЕНИЕ, не в ответ.
 * `deepThinkingBudget` калибровался по короткой задаче (575-686 знаков
 * рассуждения) и не держит многошаговый анализ конкурентных триггеров.
 *
 * Судить статикой, сколько именно съедает размышление, нельзя — это делает
 * сервер (§4 CLAUDE.md, случай 24.08 про 42P08 — тот же принцип). Поэтому
 * сторож ниже не проверяет числа, а держит две вещи, которые статикой
 * проверить МОЖНО и НУЖНО:
 *   1. вызывающий, у которого раньше было пусто (scout-innovator), явно
 *      отказывается от размышления, а не полагается на очередной угаданный
 *      потолок;
 *   2. остальные вызывающие (Editor, Scout Digest — текст для людей)
 *      размышление не теряют: решение 04.08 про глубину для них не отменено.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PROVIDERS = read('lib/ai/providers.ts');
const INNOVATOR = read('lib/agents/scout-innovator.ts');
const EDITOR = read('lib/agents/editor.ts');
const DIGEST = read('lib/agents/scout-digest.ts');

function bodyOf(src: string, name: string): string {
  const re = new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`);
  return src.match(re)?.[0] ?? '';
}

describe('callAIQuality: deepThinking управляет и бюджетом, и рычагом', () => {
  const body = bodyOf(PROVIDERS, 'callAIQuality');

  it('опция объявлена и по умолчанию true — прежнее поведение для прозы не меняется молча', () => {
    expect(PROVIDERS).toMatch(/deepThinking\?: boolean/);
    expect(body).toMatch(/deepThinking = true/);
  });

  it('при deepThinking=false бюджет DeepSeek — голый maxTokens, без надбавки на размышление', () => {
    expect(body).toMatch(/max_tokens: deepThinking \? deepThinkingBudget\(maxTokens\) : maxTokens/);
  });

  it('при deepThinking=false DeepSeek просит fast-режим (thinking отключён)', () => {
    expect(body).toMatch(/deepseekThinking\(deepThinking \? 'deep' : 'fast'\)/);
  });

  it('reasoning_content логируется, когда размышление было — иначе следующий обрыв снова придётся угадывать', () => {
    expect(body).toMatch(/reasoning_content/);
    expect(body).toMatch(/размышление=\$\{reasoningLen\}знаков/);
  });

  it('callAIQualityOrNull пробрасывает deepThinking дальше, а не глушит опцию', () => {
    const orNullBody = bodyOf(PROVIDERS, 'callAIQualityOrNull');
    expect(orNullBody).toMatch(/deepThinking\?: boolean/);
  });
});

describe('кто отказался от размышления, а кто нет', () => {
  it('scout-innovator (structured JSON, критик проверяет отдельно) — явно deepThinking: false', () => {
    expect(INNOVATOR).toMatch(/callAIQualityOrNull\(messages, \{ maxTokens: \d{4}, deepThinking: false \}\)/);
  });

  it('Editor и Scout Digest (текст для людей) размышление не теряют — вызов без deepThinking:false', () => {
    expect(EDITOR).not.toMatch(/deepThinking:\s*false/);
    expect(DIGEST).not.toMatch(/deepThinking:\s*false/);
  });
});
