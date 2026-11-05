// @vitest-environment node
/**
 * Порядок цепочки эволюции (05.11, слово владельца: «главное, чтоб не
 * нарушался порядок — решатель не раньше других»).
 *
 * Цепочка держалась на часах расписания, а GitHub доставляет её пачками с
 * опозданием на часы: 03.11 эволюция с решателем стартовала за 4 секунды до
 * конца разведки. Сторож держит обе половины связки:
 *  1. скрипт — настоящий bash с подложенным curl: предшественники не идут —
 *     звено запускается; идут — ждёт; так и не закончили — не запускается;
 *     прогоны не прочитались — не запускается (не смог ≠ можно, §4.0);
 *  2. подключение — у каждого звена шаг ожидания стоит ДО работы, называет
 *     своих предшественников, а у токена есть право actions: read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

const SCRIPT = join(process.cwd(), 'scripts', 'wait-for-predecessors.sh');
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wait-pred-'));
  // Подложенный curl: FAKE_FAIL=1 — сеть отказала; иначе total_count берётся
  // из файла-счётчика: первые FAKE_BUSY_CALLS вызовов «занято» (1), потом 0.
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash
if [ "\${FAKE_FAIL:-0}" = "1" ]; then exit 22; fi
f="$FAKE_COUNTER"; n=$(cat "$f" 2>/dev/null || echo 0); echo $((n+1)) > "$f"
if [ "$n" -lt "\${FAKE_BUSY_CALLS:-0}" ]; then echo '{"total_count":1}'; else echo '{"total_count":0}'; fi
`);
  chmodSync(join(dir, 'curl'), 0o755);
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function run(args: string[], env: Record<string, string> = {}) {
  const counter = join(dir, `counter-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync('bash', [SCRIPT, ...args], {
    env: {
      PATH: `${dir}:/usr/bin:/bin`, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r',
      WAIT_STEP_SEC: '0', FAKE_COUNTER: counter, ...env,
    },
    encoding: 'utf-8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('scripts/wait-for-predecessors.sh', () => {
  it('предшественники не идут — звено запускается', () => {
    const r = run(['cron-scout-digest.yml', 'cron-intelligence.yml']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Предшественники не идут: cron-scout-digest\.yml cron-intelligence\.yml/);
  });

  it('предшественник идёт — ждёт, потом запускается', () => {
    const r = run(['cron-scout-digest.yml'], { FAKE_BUSY_CALLS: '1', WAIT_LIMIT_SEC: '60' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Жду предшественников: cron-scout-digest\.yml\(1\)/);
    expect(r.out).toMatch(/запускаюсь/);
  });

  it('так и не закончил за срок — звено не запускается раньше него', () => {
    const r = run(['cron-evo.yml'], { FAKE_BUSY_CALLS: '1000', WAIT_LIMIT_SEC: '0' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/всё ещё идут .*cron-evo\.yml\(\d+\) — звено не запускается раньше них/);
  });

  it('прогоны не прочитались — порядок не проверен, звено не запускается', () => {
    const r = run(['cron-evo.yml'], { FAKE_FAIL: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/не смог прочитать прогоны cron-evo\.yml/);
  });

  it('без предшественников — отказ, а не «можно»', () => {
    expect(run([]).code).toBe(1);
  });
});

type Step = { name?: string; run?: string; uses?: string };
type Job = { steps: Step[]; permissions?: Record<string, string> };
type Wf = { permissions?: Record<string, string>; jobs: Record<string, Job> };

/** Звено → кого оно ждёт. Цепочка: разведка → эволюция → ревью → выпуск → судья. */
const CHAIN: Array<[file: string, job: string, waits: string[]]> = [
  ['cron-evo.yml', 'evo', ['cron-scout-digest.yml', 'cron-intelligence.yml']],
  ['evo-review.yml', 'review', ['cron-scout-digest.yml', 'cron-intelligence.yml', 'cron-evo.yml']],
  ['evo-report.yml', 'report', ['cron-evo.yml', 'evo-review.yml']],
  ['evo-judge.yml', 'judge', ['cron-evo.yml', 'evo-review.yml', 'evo-report.yml']],
];

describe('звенья цепочки эволюции ждут предшественников', () => {
  for (const [file, jobName, waits] of CHAIN) {
    it(`${file}: шаг ожидания до работы, предшественники названы, actions: read`, () => {
      const wf = load(readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf-8')) as Wf;
      const job = wf.jobs[jobName];
      expect(job, `${file}: нет джобы ${jobName}`).toBeDefined();
      const i = job.steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('scripts/wait-for-predecessors.sh'));
      expect(i, `${file}: нет шага ожидания`).toBeGreaterThanOrEqual(0);
      const named = job.steps[i].run!.split(/\s+/).filter((w) => w.endsWith('.yml'));
      expect(named.sort()).toEqual([...waits].sort());
      // До шага ожидания — только checkout: ни одного обращения к проду и модели.
      for (const s of job.steps.slice(0, i)) expect(s.uses ?? '', `${file}: до ожидания стоит «${s.name ?? s.run}»`).toMatch(/^actions\/checkout@/);
      const perms = job.permissions ?? wf.permissions ?? {};
      expect(perms.actions, `${file}: токену нужно actions: read`).toBe('read');
    });
  }
});
