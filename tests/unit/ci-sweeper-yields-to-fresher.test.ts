// @vitest-environment node
/**
 * Свипер CI на main не зовёт агента, когда решать есть кому (аудит 15.10,
 * находка AR-deploy, замечание ревью к правке).
 *
 * С 15.10 CI идёт на каждый пуш в main без фильтра путей — и на коммиты,
 * меняющие только маркер .github/triggers/. Маркер в режиме apply краснит CI
 * нарочно (сторожа images-repack, timeweb-configure, iamkam-site,
 * s3-object-delete требуют dry), следом идёт возврат в dry. До 15.10 такие
 * коммиты CI на push не запускали; без этого правила каждый будил бы агента
 * свипера (до 50 ходов, с секретами) и открывал draft-PR «ГОРЯЧО: CI на main
 * красный». Свипер — уже главная статья расходов (§5.1, около 40% дневного
 * счёта 06.09).
 *
 * Сторож судит ПОВЕДЕНИЕ (CLAUDE.md §4, 13.10): джоб свипера проигрывается
 * шаг за шагом — `if:` вычисляется по контексту события и выходам прежних
 * шагов, `run:` исполняется с заглушкой gh, — и проверяется, дошло ли дело
 * до шага с агентом. Регулярки по исходнику нет.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, evalIf, evalTemplate, type WorkflowStep } from '../helpers/workflow-semantics';

const sweeper = loadWorkflow('.github/workflows/ci-sweeper.yml');
const job = sweeper.jobs['sweep'];
const AGENT_STEP = 'Run Claude sweeper';
const UPLOAD_STEP = 'Файл выполнения руки — для учёта расхода';

const REPO = 'tourhabk-ui/pos';
const RUN_ID = 1000;
const SHA = 'a'.repeat(40);

interface Opts {
  branch?: string;
  conclusion?: string;
  /** Прогоны CI по пушу в main, как их отдаёт GitHub. */
  runs?: Array<{ id: number; status: string; conclusion: string | null }>;
  /** Файлы упавшего коммита. */
  files?: string[];
  runsFail?: boolean;
  commitFail?: boolean;
  message?: string;
}

function ctx(o: Opts, steps: Record<string, { outputs: Record<string, string> }>): Record<string, unknown> {
  return {
    github: {
      event_name: 'workflow_run',
      repository: REPO,
      token: 'ghs_test',
      event: {
        workflow_run: {
          id: RUN_ID,
          conclusion: o.conclusion ?? 'failure',
          event: 'push',
          head_branch: o.branch ?? 'main',
          head_sha: SHA,
          head_commit: { message: o.message ?? 'правка' },
          head_repository: { full_name: REPO },
        },
      },
    },
    secrets: { ANTHROPIC_API_KEY: 'sk-test' },
    vars: {},
    steps,
  };
}

// gh: журнал вызовов; отвечает по адресу из FAKE_DIR. Ветка существует всегда.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/gh.log"
if [ "$1" = "api" ]; then
  case "$2" in
    */actions/workflows/ci.yml/runs*)
      if [ -f "$FAKE_DIR/runs-fail" ]; then echo "HTTP 403: Resource not accessible" >&2; exit 1; fi
      cat "$FAKE_DIR/runs.json";;
    */commits/*)
      if [ -f "$FAKE_DIR/commit-fail" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
      cat "$FAKE_DIR/commit.json";;
    */git/ref/heads/*) exit 0;;
  esac
fi
exit 0
`;

let work: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ci-sweeper-fresh-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** GITHUB_OUTPUT: `k=v` и многострочное `K<<DELIM … DELIM`. */
function parseOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]);
      out[heredoc[1]] = body.join('\n');
      continue;
    }
    const eq = lines[i].indexOf('=');
    if (eq > 0) out[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
  }
  return out;
}

interface Sim { jobRuns: boolean; ran: string[]; out: string; gh: string[] }

/** Проигрывает джоб свипера: какие шаги дошли до исполнения. */
function simulate(o: Opts): Sim {
  const fake = mkdtempSync(join(work, 'fake-'));
  writeFileSync(join(fake, 'runs.json'), JSON.stringify({
    workflow_runs: (o.runs ?? []).map((r) => ({ ...r, head_sha: 'c'.repeat(40) })),
  }));
  writeFileSync(join(fake, 'commit.json'), JSON.stringify({
    sha: SHA, files: (o.files ?? ['lib/x.ts']).map((filename) => ({ filename })),
  }));
  if (o.runsFail) writeFileSync(join(fake, 'runs-fail'), '1');
  if (o.commitFail) writeFileSync(join(fake, 'commit-fail'), '1');

  const steps: Record<string, { outputs: Record<string, string>; outcome?: string }> = {};
  const ran: string[] = [];
  let out = '';
  const jobRuns = evalIf(job.if, ctx(o, steps));
  if (jobRuns) {
    for (const step of (job.steps ?? []) as Array<WorkflowStep & { id?: string }>) {
      const c = ctx(o, steps);
      // Исход шага — как у GitHub: пропущенный шаг виден следующим как
      // `skipped` (по нему решает шаг учёта расхода руки, аудит 15.10 AC-1).
      if (!evalIf(step.if, c)) {
        if (step.id) steps[step.id] = { outputs: {}, outcome: 'skipped' };
        continue;
      }
      ran.push(step.name ?? step.uses ?? '?');
      if (!step.run) { // checkout и экшен агента не исполняются — важно, что до них дошло
        if (step.id) steps[step.id] = { outputs: {}, outcome: 'success' };
        continue;
      }
      const outFile = join(fake, `out-${ran.length}`);
      writeFileSync(outFile, '');
      const env: Record<string, string> = {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? work,
        FAKE_DIR: fake,
        RUNNER_TEMP: fake,
        GITHUB_OUTPUT: outFile,
      };
      for (const [k, v] of Object.entries(step.env ?? {})) {
        const val = evalTemplate(v, c);
        env[k] = val === null || val === undefined ? '' : String(val);
      }
      const script = String(evalTemplate(step.run, c));
      try {
        out += execFileSync('bash', ['-e', '-c', script], { cwd: fake, env, encoding: 'utf-8', stdio: 'pipe' });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        out += `${e.stdout ?? ''}${e.stderr ?? ''}`;
        throw new Error(`шаг «${step.name}» упал: ${out}`);
      }
      if (step.id) steps[step.id] = { outputs: parseOutput(readFileSync(outFile, 'utf-8')), outcome: 'success' };
    }
  }
  const ghLog = join(fake, 'gh.log');
  return {
    jobRuns,
    ran,
    out,
    gh: existsSync(ghLog) ? readFileSync(ghLog, 'utf-8').split('\n').filter(Boolean) : [],
  };
}

const ourRun = { id: RUN_ID, status: 'completed', conclusion: 'failure' };

describe('красный main, следом прогон более свежего пуша — агент не зовётся', () => {
  for (const newer of [
    { id: 1001, status: 'queued', conclusion: null },
    { id: 1001, status: 'pending', conclusion: null },
    { id: 1001, status: 'in_progress', conclusion: null },
    { id: 1001, status: 'completed', conclusion: 'success' },
    { id: 1001, status: 'completed', conclusion: 'failure' }, // его свип и починит последнее состояние
  ]) {
    it(`${newer.status}/${newer.conclusion ?? '-'}`, () => {
      const s = simulate({ runs: [ourRun, newer] });
      expect(s.jobRuns).toBe(true);
      expect(s.ran, 'агент свипера на красном прогоне, который решит более свежий').not.toContain(AGENT_STEP);
      expect(s.ran, 'и checkout не нужен').not.toContain('Checkout failing branch');
      // Агент не звался — и файла выполнения ждать неоткуда.
      expect(s.ran).not.toContain(UPLOAD_STEP);
      expect(s.out).toMatch(/он и решит/);
    });
  }

  it('маркер в apply и возврат в dry следом (случай a41e6c7d1 → e44f05077) — свипа нет', () => {
    const s = simulate({
      runs: [ourRun, { id: 1001, status: 'queued', conclusion: null }],
      files: ['.github/triggers/images-repack.json'],
    });
    expect(s.ran).not.toContain(AGENT_STEP);
  });
});

describe('красный main, более свежего прогона нет', () => {
  it('коммит с кодом — агент зовётся, как раньше', () => {
    const s = simulate({ runs: [ourRun] });
    expect(s.ran).toContain(AGENT_STEP);
    // Агент звался — файл выполнения уезжает к учёту расхода (аудит 15.10, AC-1).
    expect(s.ran.indexOf(UPLOAD_STEP)).toBeGreaterThan(s.ran.indexOf(AGENT_STEP));
  });

  it('прогоны старше нашего не решают за нас', () => {
    const s = simulate({ runs: [{ id: 998, status: 'in_progress', conclusion: null }, ourRun] });
    expect(s.ran).toContain(AGENT_STEP);
  });

  it('более свежий отменён (его заменил ещё более свежий) — не в счёт, если других нет', () => {
    const s = simulate({ runs: [ourRun, { id: 1001, status: 'completed', conclusion: 'cancelled' }] });
    expect(s.ran).toContain(AGENT_STEP);
  });

  it('коммит меняет только маркеры (случай 745cab8f2: dry через 46 мин) — агент не зовётся', () => {
    const s = simulate({
      runs: [ourRun],
      files: ['.github/triggers/images-repack.json'],
    });
    expect(s.ran).not.toContain(AGENT_STEP);
    expect(s.out).toMatch(/меняет только маркеры/);
  });

  it('несколько маркеров разом — тоже только маркеры', () => {
    const s = simulate({
      runs: [ourRun],
      files: ['.github/triggers/timeweb-configure.json', '.github/triggers/iamkam-site.json'],
    });
    expect(s.ran).not.toContain(AGENT_STEP);
  });

  it('маркер вместе с кодом — агент зовётся: красный может быть от кода', () => {
    const s = simulate({
      runs: [ourRun],
      files: ['.github/triggers/images-repack.json', 'lib/images/repack.ts'],
    });
    expect(s.ran).toContain(AGENT_STEP);
  });

  it('файл рядом с маркерами, но не маркер — агент зовётся', () => {
    const s = simulate({ runs: [ourRun], files: ['.github/workflows/images-repack.yml'] });
    expect(s.ran).toContain(AGENT_STEP);
  });

  it('пустой список файлов — не «только маркеры»', () => {
    const s = simulate({ runs: [ourRun], files: [] });
    expect(s.ran).toContain(AGENT_STEP);
  });
});

describe('«не смог спросить» не выдаётся за «решит другой» (§4.0)', () => {
  it('GitHub не ответил о прогонах — предупреждение вслух, агент зовётся', () => {
    const s = simulate({ runsFail: true });
    expect(s.out).toMatch(/::warning::Не смог спросить GitHub о более свежих прогонах CI/);
    expect(s.ran).toContain(AGENT_STEP);
  });

  it('GitHub не отдал файлы коммита — предупреждение вслух, агент зовётся', () => {
    const s = simulate({ runs: [ourRun], commitFail: true, files: ['.github/triggers/images-repack.json'] });
    expect(s.out).toMatch(/::warning::Не смог прочитать файлы коммита/);
    expect(s.ran).toContain(AGENT_STEP);
  });
});

describe('PR-ветки — поведение прежнее', () => {
  it('красный PR при более свежем прогоне main — агент зовётся, про main не спрашиваем', () => {
    const s = simulate({
      branch: 'claude/feature',
      runs: [ourRun, { id: 1001, status: 'in_progress', conclusion: null }],
      files: ['.github/triggers/images-repack.json'],
    });
    expect(s.ran).toContain(AGENT_STEP);
    expect(s.gh.some((l) => l.includes('/actions/workflows/ci.yml/runs'))).toBe(false);
  });

  it('зелёный CI — свипера нет вовсе', () => {
    expect(simulate({ conclusion: 'success', runs: [ourRun] }).jobRuns).toBe(false);
  });

  it('упал коммит самого свипера — второй попытки нет (защита от зацикливания)', () => {
    expect(simulate({ runs: [ourRun], message: 'fix: тест [ci-sweep]' }).jobRuns).toBe(false);
    expect(simulate({ runs: [ourRun], message: 'fix: тест' }).jobRuns).toBe(true);
  });
});
