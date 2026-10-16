/**
 * Панель видимости — скрипт и workflow (замер владельца 16.10; критерии —
 * docs/agents/AI_VISIBILITY.md).
 *
 * Скрипт судится исполнением: разбор маркера и потолок дня — вызовом,
 * отказы без набора вопросов и отчёт по сырью — настоящим запуском tsx на
 * подложенных файлах (без сети: до каталога моделей эти пути не доходят).
 * Workflow — разобранным YAML и шагом скачивания на настоящем bash с
 * подложенным gh (CLAUDE.md §4, «сторож судит поведение, не текст»).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarker, applyGate } from '@/scripts/ai-visibility-panel';
import { markAnswer } from '@/lib/ai/visibility-panel';
import { loadWorkflow, stepByName, evalIf } from '../helpers/workflow-semantics';

const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const SCRIPT = join(ROOT, 'scripts/ai-visibility-panel.ts');

describe('маркер', () => {
  it('по умолчанию — dry, 5 повторов, все ассистенты; цены нет — потолка нет', () => {
    const { marker, problems } = parseMarker({});
    expect(problems).toEqual([]);
    expect(marker).toMatchObject({ mode: 'dry', repeats: 5, max_usd: null, questions: 'docs/agents/visibility/questions.json' });
    expect(marker.assistants).toEqual(['chatgpt', 'perplexity', 'gemini', 'grok', 'yandexgpt']);
  });

  it('негодные поля — проблемы со словами, а не тихие умолчания', () => {
    const { problems } = parseMarker({ mode: 'run', repeats: 50, assistants: ['claude'], max_usd: -1, models: { chatgpt: 1 }, baseline_runs: 'x' });
    expect(problems.join('\n')).toMatch(/mode/);
    expect(problems.join('\n')).toMatch(/repeats/);
    expect(problems.join('\n')).toMatch(/assistants/);
    expect(problems.join('\n')).toMatch(/max_usd/);
    expect(problems.join('\n')).toMatch(/models\.chatgpt/);
    expect(problems.join('\n')).toMatch(/baseline_runs/);
  });
});

describe('потолок дня — до первого вызова', () => {
  const plan = (est_usd: number | null, calls = 100) => ({ est_usd, calls });
  it('без потолка, без цены, выше потолка и без ассистентов — отказ', () => {
    expect(applyGate(null, plan(10))).toMatch(/max_usd/);
    expect(applyGate(50, plan(null))).toMatch(/цену/);
    expect(applyGate(50, plan(51))).toMatch(/выше потолка/);
    expect(applyGate(50, plan(0, 0))).toMatch(/спросить нечем/);
  });
  it('оценка в пределах потолка — можно', () => {
    expect(applyGate(50, plan(49.9))).toBeNull();
  });
});

// ── Запуск скрипта ──────────────────────────────────────────────────────

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'panel-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function run(marker: Record<string, unknown>, sub: string): { code: number; out: string; outDir: string } {
  const base = join(dir, sub);
  mkdirSync(base, { recursive: true });
  const markerPath = join(base, 'marker.json');
  writeFileSync(markerPath, JSON.stringify(marker));
  const outDir = join(base, 'out');
  const env = { ...process.env, OPENROUTER_API_KEY: '', GITHUB_STEP_SUMMARY: '', GITHUB_ACTIONS: '' };
  const r = spawnSync(TSX, [SCRIPT, markerPath, outDir, join(dir, 'in')], { cwd: ROOT, encoding: 'utf-8', env, timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, outDir };
}

describe('без набора вопросов не меряют', () => {
  it('файла нет — красный с причиной', () => {
    const r = run({ mode: 'dry', questions: join(dir, 'nope.json') }, 'missing');
    expect(r.code).toBe(1);
    expect(r.out).toContain('набора вопросов нет');
  });

  it('ни одного годного вопроса (нет источника) — красный, а не пустой успех', () => {
    const q = join(dir, 'bad.json');
    writeFileSync(q, JSON.stringify([{ id: 'a', text: 'Когда ехать?', lang: 'ru', intent: 'planning' }]));
    const r = run({ mode: 'dry', questions: q }, 'bad');
    expect(r.code).toBe(1);
    expect(r.out).toContain('ни одного годного вопроса');
    expect(r.out).toMatch(/источник/);
  });
});

// ── Отчёт по сырью ─────────────────────────────────────────────────────

function day(id: string, sha: string, per: Record<string, { ours: number; comp: number; n: number }>) {
  const d = join(dir, 'in', id, `ai-visibility-run1-apply-${id}`);
  mkdirSync(d, { recursive: true });
  const rows: string[] = [];
  for (const [assistant, { ours, comp, n }] of Object.entries(per)) {
    for (let i = 0; i < n; i++) {
      const text = `${i < ours ? 'Туры — на vedarai.ru. ' : ''}${i < comp ? 'И на kamchatkaland.ru.' : 'Ответ.'}`;
      rows.push(JSON.stringify({ assistant, question_id: `q${i}`, intent: 'prices', day: id, repeat: 1, outcome: 'answered', text, marks: markAnswer(text, []) }));
    }
  }
  writeFileSync(join(d, 'answers.jsonl'), `${rows.join('\n')}\n`);
  writeFileSync(join(d, 'meta.json'), JSON.stringify({ question_sha256: sha, models: [{ assistant: 'yandexgpt', model: null, reason: 'нет ключа' }] }));
}

describe('отчёт по сырью', () => {
  beforeAll(() => {
    day('101', 'S', { chatgpt: { ours: 0, comp: 5, n: 30 }, grok: { ours: 0, comp: 5, n: 30 } });
    day('102', 'S', { chatgpt: { ours: 0, comp: 5, n: 30 }, grok: { ours: 0, comp: 5, n: 30 } });
    day('201', 'S', { chatgpt: { ours: 12, comp: 5, n: 30 }, grok: { ours: 9, comp: 5, n: 30 } });
    day('301', 'OTHER', { chatgpt: { ours: 12, comp: 5, n: 30 } });
  });

  it('база и повтор с конкурентом — вердикт К1+К2 и карта источников в report.json', () => {
    const r = run({ mode: 'report', baseline_runs: ['101', '102'], followup_runs: ['201'], competitors: ['kamchatkaland.ru'] }, 'rep-ok');
    expect(r.code, r.out).toBe(0);
    const rep = JSON.parse(readFileSync(join(r.outDir, 'report.json'), 'utf-8'));
    expect(rep.verdict).toMatchObject({ outcome: 'met', counted: ['chatgpt', 'grok'] });
    expect(r.out).toContain('не измерено: нет ключа');
    expect(r.out).toContain('Вердикт К1+К2: **выполнен**');
  });

  it('повтор без записанных конкурентов — вердикта нет, и прогон красный', () => {
    const r = run({ mode: 'report', baseline_runs: ['101'], followup_runs: ['201'] }, 'rep-nocomp');
    expect(r.code).toBe(1);
    expect(r.out).toContain('не смог проверить');
    expect(JSON.parse(readFileSync(join(r.outDir, 'report.json'), 'utf-8')).verdict).toBeNull();
  });

  it('разные наборы вопросов в базе и повторе — сравнивать нельзя', () => {
    const r = run({ mode: 'report', baseline_runs: ['101'], followup_runs: ['301'], competitors: ['kamchatkaland.ru'] }, 'rep-sha');
    expect(r.code).toBe(1);
    expect(r.out).toContain('наборы вопросов в прогонах разные');
    expect(existsSync(join(r.outDir, 'report.json'))).toBe(false);
  });

  it('сырья прогона нет — красный, а не отчёт по половине', () => {
    const r = run({ mode: 'report', baseline_runs: ['101', '999'] }, 'rep-missing');
    expect(r.code).toBe(1);
    expect(r.out).toContain('сырья прогона 999 нет');
  });
});

// ── Workflow ────────────────────────────────────────────────────────────

const wf = loadWorkflow('.github/workflows/ai-visibility-panel.yml');
const job = wf.jobs.panel;

describe('workflow панели', () => {
  it('запускается маркером в main и вручную; прогоны идут по очереди, без отмены', () => {
    const push = wf.on.push as { branches: string[]; paths: string[] };
    expect(push.branches).toEqual(['main']);
    expect(push.paths).toEqual(['.github/triggers/ai-visibility-panel.json']);
    expect(Object.keys(wf.on)).toContain('workflow_dispatch');
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('ключ модели и CRON_SECRET — только у шага, который спрашивает', () => {
    const panel = stepByName(job, 'Панель');
    expect(panel.env).toEqual({ OPENROUTER_API_KEY: '${{ secrets.OPENROUTER_API_KEY }}', CRON_SECRET: '${{ secrets.CRON_SECRET }}' });
    for (const s of job.steps ?? []) {
      if (s === panel) continue;
      expect(JSON.stringify(s.env ?? {}), s.name).not.toMatch(/OPENROUTER_API_KEY|CRON_SECRET/);
    }
  });

  it('сырьё живёт дольше восьми недель: повтор через 56 дней сравнивает с ним', () => {
    const up = stepByName(job, 'Сырьё — в артефакт') as { with?: Record<string, unknown>; if?: string };
    expect(Number(up.with?.['retention-days'])).toBeGreaterThanOrEqual(70);
    expect(up.if).toBe('always()');
  });

  it('сырьё прошлых прогонов качается только в режиме report', () => {
    const dl = stepByName(job, 'Сырьё прошлых прогонов');
    const ctx = (mode: string) => ({ steps: { mode: { outputs: { mode } } } });
    expect(evalIf(dl.if, ctx('report'))).toBe(true);
    expect(evalIf(dl.if, ctx('apply'))).toBe(false);
  });

  describe('шаг скачивания на настоящем bash', () => {
    function download(runs: unknown[]): { code: number; out: string; calls: string } {
      const w = mkdtempSync(join(tmpdir(), 'panel-dl-'));
      try {
        mkdirSync(join(w, '.github/triggers'), { recursive: true });
        writeFileSync(join(w, '.github/triggers/ai-visibility-panel.json'), JSON.stringify({ mode: 'report', baseline_runs: runs }));
        mkdirSync(join(w, 'bin'));
        writeFileSync(join(w, 'bin/gh'), '#!/bin/sh\necho "$@" >> "$GH_LOG"\n');
        chmodSync(join(w, 'bin/gh'), 0o755);
        const log = join(w, 'gh.log');
        const r = spawnSync('bash', ['-e', '-c', stepByName(job, 'Сырьё прошлых прогонов').run ?? ''], {
          cwd: w, encoding: 'utf-8',
          env: { ...process.env, PATH: `${join(w, 'bin')}:${process.env.PATH}`, GH_LOG: log, GITHUB_REPOSITORY: 'tourhabk-ui/pos' },
        });
        return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, 'utf-8') : '' };
      } finally {
        rmSync(w, { recursive: true, force: true });
      }
    }

    it('номера прогонов — каждый своей папкой', () => {
      const r = download([38865596275, '38865596276']);
      expect(r.code, r.out).toBe(0);
      expect(r.calls.trim().split('\n')).toEqual([
        'run download 38865596275 -R tourhabk-ui/pos -D panel-in/38865596275',
        'run download 38865596276 -R tourhabk-ui/pos -D panel-in/38865596276',
      ]);
    });

    it('не число — отказ до скачивания', () => {
      const r = download(['123', '../x']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('не число');
      expect(r.calls).toBe('');
    });
  });
});
