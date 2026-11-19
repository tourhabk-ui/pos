// @vitest-environment node
/**
 * Ночной разбор задач просит у модели ограниченный ответ (слово владельца
 * 19.11 «go»).
 *
 * Без предела Claude Code просит 128 000 токенов на ход. OpenRouter заранее
 * сверяет этот запрос с остатком на счёте и при нехватке отказывает 402 до
 * всякой работы: 18.11 и 19.11 разбор упал так («You requested up to 128000
 * tokens, but can only afford 59129»), хотя пишет он короткий JSON.
 *
 * Здесь — сам артефакт: шаг руки разбора несёт предел, и он разумный (число,
 * больше нуля и не больше 32 000). Пополнение счёта предел не заменяет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface Step { id?: string; name?: string; uses?: string; env?: Record<string, unknown> }
interface Job { steps?: Step[] }

function handStep(): Step {
  const wf = load(readFileSync(join(process.cwd(), '.github/workflows/issue-triage.yml'), 'utf-8')) as { jobs?: Record<string, Job> };
  const step = wf.jobs?.triage?.steps?.find((s) => String(s.uses ?? '').startsWith('anthropics/claude-code-action'));
  if (!step) throw new Error('в issue-triage.yml нет шага руки разбора');
  return step;
}

describe('ночной разбор: предел ответа модели', () => {
  it('шаг руки задаёт CLAUDE_CODE_MAX_OUTPUT_TOKENS числом от 1 до 32 000', () => {
    const raw = handStep().env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    expect(raw, 'предела нет — Claude Code попросит 128 000 токенов на ход').toBeDefined();
    const n = Number(raw);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(32_000);
  });
});
