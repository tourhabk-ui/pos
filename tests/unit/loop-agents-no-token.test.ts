/**
 * Петли-агенты (ci-sweeper, issue-triage, weekly-chronicle) не держат токен
 * GitHub (аудит агентов 02.11, разрыв №1).
 *
 * У агента Bash/Write на раннере: всё, что лежит в его окружении или в
 * .git/config, модель может прочитать (`env`, `cat .git/config`) — и под
 * чужой подсказкой из текста issue или лога унести. Поэтому:
 *  - в шаге claude-code-action нет GH_TOKEN/GITHUB_TOKEN и входа github_token;
 *  - CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' — экшен вычищает свой токен из Bash;
 *  - checkout без persist-credentials — в .git/config учётки нет;
 *  - подсказка агента не велит звать gh / git push;
 *  - запись (push, PR, лейблы, комментарии) — шаг ПОСЛЕ агента, с токеном.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (s: string) => unknown };

type Step = { id?: string; name?: string; uses?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Wf = { jobs: Record<string, { steps?: Step[] }> };

const LOOPS = ['ci-sweeper', 'issue-triage', 'weekly-chronicle'];

for (const name of LOOPS) {
  const wf = yaml.load(readFileSync(path.join('.github/workflows', `${name}.yml`), 'utf8')) as Wf;
  const job = Object.values(wf.jobs).find((j) => j.steps?.some((s) => s.uses?.startsWith('anthropics/claude-code-action')));
  const steps = job?.steps ?? [];
  const handIdx = steps.findIndex((s) => s.uses?.startsWith('anthropics/claude-code-action'));
  const hand = steps[handIdx];

  describe(`${name}: агент без токена GitHub`, () => {
    it('шаг агента найден', () => expect(hand).toBeTruthy());

    it('в env шага агента нет токена, а scrub включён', () => {
      const env = hand.env ?? {};
      for (const k of Object.keys(env)) expect(k).not.toMatch(/TOKEN|SECRET/);
      expect(Object.values(env).join(' ')).not.toMatch(/github\.token|secrets\./);
      expect(String(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)).toBe('1');
    });

    it('экшену не передан github_token', () => {
      expect(hand.with?.github_token).toBeUndefined();
    });

    it('checkout до агента не оставляет учётку в .git/config', () => {
      for (const s of steps.slice(0, handIdx)) {
        if (s.uses?.startsWith('actions/checkout')) expect(s.with?.['persist-credentials']).toBe(false);
      }
    });

    it('подсказка агента не велит ходить в GitHub', () => {
      const prompt = String(hand.with?.prompt ?? '');
      expect(prompt).not.toMatch(/^\s*gh (run|pr|issue) /m);
      expect(prompt).not.toMatch(/git push(?! работать не будут)/);
      expect(String(hand.with?.claude_args ?? '')).toMatch(/--allowedTools/);
    });

    it('запись — отдельным шагом после агента, с токеном', () => {
      const after = steps.slice(handIdx + 1).filter((s) => s.env?.GH_TOKEN === '${{ github.token }}');
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((s) => String(s.if ?? '').includes("steps.hand.outcome == 'success'"))).toBe(true);
    });
  });
}
