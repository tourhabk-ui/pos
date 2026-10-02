/**
 * Догадки запасной ступени решателя не публикуются (решение владельца 02.10:
 * «догадки deepseek-flash отбрасывать, публиковать только то, что дал Opus»).
 *
 * Повод — issue 2156: «пустой if в sms.ts», уже исправленный в main, найден
 * deepseek-flash и стал единственным ежедневным «пробником» тормоза точности.
 * Точность запасных моделей (flash 40%, chat 57%) тянула общую ниже порога,
 * а пробник доставался именно им.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPublishDecision, decidePublish, isFallbackRungGuess, FALLBACK_RUNG_STAMP, GUESS_PROBE, MIN_SAMPLE,
} from '@/lib/agents/evo/precision';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const f = (id: string, model: string | null | undefined, over: Record<string, unknown> = {}) =>
  ({ id, category: 'bug', severity: 'medium', model, ...over });

const BRAKE_ON = decidePublish({ accepted: 22, rejected: 30 });
const BRAKE_OFF = decidePublish({ accepted: 30, rejected: 5 });
const UNMEASURED = decidePublish({ accepted: 1, rejected: 1 });

describe('кто считается догадкой запасной ступени', () => {
  it('штамп DeepSeek — да; флагман, xAI, Timeweb, Anthropic напрямую — нет', () => {
    for (const m of ['deepseek-flash', 'deepseek-chat', 'deepseek-v4-pro', 'DeepSeek-Chat']) {
      expect(isFallbackRungGuess(f('a', m)), m).toBe(true);
    }
    for (const m of ['anthropic/claude-opus-5.5', 'claude-opus-5-5', 'timeweb:claude', 'grok-4.6', 'z-ai/glm-5.3']) {
      expect(isFallbackRungGuess(f('a', m)), m).toBe(false);
    }
  });

  it('штампа нет — «не знаю», а не «плохо»: не отбрасывается (§4.0)', () => {
    expect(isFallbackRungGuess(f('a', null))).toBe(false);
    expect(isFallbackRungGuess(f('a', undefined))).toBe(false);
  });

  it('детерминированные находки не гадают, какой бы штамп ни стоял', () => {
    expect(isFallbackRungGuess({ category: 'tech_debt', model: 'deepseek-flash' })).toBe(false);
    expect(isFallbackRungGuess({ category: 'bug', fault_side: 'environment', model: 'deepseek-flash' })).toBe(false);
  });
});

describe('публикация: запасная ступень не проходит ни при какой точности', () => {
  const set = [f('flash', 'deepseek-flash', { severity: 'high' }), f('opus', 'anthropic/claude-opus-5.5'), f('det', 'deterministic', { category: 'tech_debt' })];

  it('тормоз включён: пробник — от флагмана, а не от «самой тяжёлой» запасной', () => {
    const out = applyPublishDecision(set, BRAKE_ON).map((x) => x.id);
    // flash тяжелее (high), но он запасной: пробником становится opus.
    expect(out).toEqual(['opus', 'det']);
    expect(GUESS_PROBE).toBe(1);
  });

  it('тормоз выключен: запасная всё равно не публикуется', () => {
    expect(applyPublishDecision(set, BRAKE_OFF).map((x) => x.id)).toEqual(['opus', 'det']);
  });

  it('точность «не измерена» (окно выветрилось) — запасная не хлынет в трекер', () => {
    expect(UNMEASURED.allowGuesses).toBe(true);
    expect(applyPublishDecision(set, UNMEASURED).map((x) => x.id)).toEqual(['opus', 'det']);
    expect(MIN_SAMPLE).toBeGreaterThan(2);
  });

  it('под тормозом, если флагман ничего не дал, пробника нет вовсе — честный ноль, а не запасная', () => {
    const only = [f('flash', 'deepseek-flash'), f('chat', 'deepseek-chat'), f('det', 'deterministic', { category: 'tech_debt' })];
    expect(applyPublishDecision(only, BRAKE_ON).map((x) => x.id)).toEqual(['det']);
  });

  it('порядок остальных сохраняется', () => {
    const many = [f('o1', 'anthropic/claude-opus-5.5', { severity: 'low' }), f('d1', 'deterministic', { category: 'ux' }), f('o2', 'anthropic/claude-opus-5.5', { severity: 'high' })];
    // Пробник — o2 (тяжелее); o1 придержан тормозом; детерминированная идёт.
    expect(applyPublishDecision(many, BRAKE_ON).map((x) => x.id)).toEqual(['d1', 'o2']);
  });
});

describe('выборка роута', () => {
  const route = read('app/api/cron/evo-report/route.ts');

  it('запасные идут в хвост выборки, чтобы не занять все 50 мест; шаблон — из одного источника', () => {
    expect(route).toMatch(/\(COALESCE\(model, ''\) ~\* \$1\) ASC/);
    expect(route).toMatch(/\[FALLBACK_RUNG_STAMP\.source\]/);
    expect(FALLBACK_RUNG_STAMP.source).toBe('^deepseek');
  });

  it('счёт пропущенных запасных виден в ответе: «0 находок» неотличимо от «чисто» иначе', () => {
    expect(route).toMatch(/fallback_rung_guesses_skipped: fallbackSkipped/);
    expect(route).toMatch(/verified\.filter\(\(f\) => isFallbackRungGuess\(f\)\)\.length/);
  });
});
