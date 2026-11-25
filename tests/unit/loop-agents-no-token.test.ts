/**
 * Петли-агенты (ci-sweeper, issue-triage, weekly-chronicle) и рука по задачам
 * (claude.yml, скан безопасности 25.11) не держат токен GitHub (аудит агентов
 * 02.11, разрыв №1).
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

const LOOPS = ['ci-sweeper', 'issue-triage', 'weekly-chronicle', 'claude'];

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
      for (const k of Object.keys(env)) {
        // Предел ответа модели (issue-triage, 19.11) — счётчик, а не учётка:
        // имя названо поимённо, и значение обязано быть числом.
        if (k === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS') {
          expect(String(env[k])).toMatch(/^\d+$/);
          continue;
        }
        expect(k).not.toMatch(/TOKEN|SECRET/);
      }
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

    // Рука по задачам пишет не шагом рядом, а своей работой (ревью #3831):
    // её проверяет отдельный блок ниже.
    if (name !== 'claude') {
      it('запись — отдельным шагом после агента, с токеном', () => {
        const after = steps.slice(handIdx + 1).filter((s) => s.env?.GH_TOKEN === '${{ github.token }}');
        expect(after.length).toBeGreaterThan(0);
        expect(after.every((s) => String(s.if ?? '').includes("steps.hand.outcome == 'success'"))).toBe(true);
      });
    }
  });
}

/**
 * Рука по задачам: запись — отдельной работой на чистом раннере (ревью
 * безопасности #3831). В одной работе с агентом шаг записи был беззащитен:
 * агент правил .git/config (url.insteadOf уводил push с заголовком токена на
 * чужой хост), подкладывал BASH_ENV/PATH через GITHUB_ENV/GITHUB_PATH, менял
 * файл с базой; путь с кириллицей прятался в кавычки git от регулярки, а
 * сама регулярка была подмножеством реестра зон.
 */
describe('claude: запись руки — своей работой, без агента рядом', () => {
  type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps?: (Step & { run?: string })[] };
  const wf = yaml.load(readFileSync(path.join('.github/workflows', 'claude.yml'), 'utf8')) as { jobs: Record<string, Job> };
  const isHand = (j: Job) => (j.steps ?? []).some((s) => s.uses?.startsWith('anthropics/claude-code-action'));
  const handJob = wf.jobs.claude;
  const entries = Object.entries(wf.jobs).filter(([, j]) => (j.steps ?? []).some((s) => s.env?.GH_TOKEN === '${{ github.token }}'));
  const [writeId, write] = entries[0] ?? ['', {} as Job];
  const writeStep = (write.steps ?? []).find((s) => s.env?.GH_TOKEN === '${{ github.token }}');
  const run = String(writeStep?.run ?? '');

  it('токен записи — ровно в одной работе, и это не работа агента', () => {
    expect(entries.map(([id]) => id)).toEqual([writeId]);
    expect(isHand(write)).toBe(false);
    expect(JSON.stringify(handJob.steps)).not.toMatch(/github\.token|GH_TOKEN/);
  });

  it('работа записи ждёт руку и идёт только при её успехе', () => {
    const needs = Array.isArray(write.needs) ? write.needs : [write.needs];
    expect(needs).toContain('claude');
    expect(String(write.if)).toContain("needs.claude.outputs.hand_outcome == 'success'");
  });

  it('из работы руки уезжают только данные — артефакт hand-out', () => {
    const up = (handJob.steps ?? []).find((s) => s.uses?.startsWith('actions/upload-artifact') && s.with?.name === 'hand-out');
    expect(up).toBeTruthy();
    const down = (write.steps ?? []).find((s) => s.uses?.startsWith('actions/download-artifact'));
    expect(down?.with?.name).toBe('hand-out');
    expect(String(down?.with?.path)).toMatch(/^\$\{\{\s*runner\.temp\s*\}\}\//);
  });

  it('копия записи чистая: свой checkout без учётки, конфиг git только её', () => {
    const co = (write.steps ?? []).find((s) => s.uses?.startsWith('actions/checkout'));
    expect(co?.with?.['persist-credentials']).toBe(false);
    expect(co?.with?.ref).toBeUndefined();
    expect(writeStep?.env?.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(String(writeStep?.env?.GIT_CONFIG_NOSYSTEM)).toBe('1');
    expect(String(writeStep?.env?.GIT_NO_REPLACE_OBJECTS)).toBe('1');
    expect(run).toMatch(/core\.hooksPath=\/dev\/null/);
  });

  it('база — из своей копии, а не из файла, доступного агенту', () => {
    expect(run).toMatch(/base=\$\(git rev-parse --verify 'HEAD\^\{commit\}'\)/);
    expect(run).not.toMatch(/hand-base-sha/);
    expect(run).toMatch(/merge-base --is-ancestor "\$base" "\$tip"/);
    expect(run).toMatch(/--min-parents=2/);
  });

  it('пути — по каждому коммиту, без кавычек git, по реестру зон', () => {
    expect(run).toMatch(/core\.quotePath=false diff-tree -r -z/);
    expect(run).toMatch(/zonesOfFile/);
    expect(run).toMatch(/startsWith\("\.github\/"\)/);
    // Не прочитал список — не пушу (§4.0): пустой список краснит.
    expect(run).toMatch(/files\.length === 0[^\n]*process\.exit\(1\)/);
    expect(run).not.toMatch(/grep -E '\^\(app\/api\/payments/);
  });
});
