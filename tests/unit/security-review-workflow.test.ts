/**
 * Security Review workflow (evo #795): AI-ревью диффа PR через официальный
 * экшен Anthropic — дополняет CodeQL.
 *
 * Сторож судит смысл workflow (разобранный YAML, вычисленные условия) и
 * исполняет шаг «Ревью состоялось» настоящим bash на подложенных итогах
 * экшена (CLAUDE.md §4, «сторож судит поведение, не текст»).
 *
 * 16.10: ревью PR #2537 получило 401 «Invalid API key» на отдельном секрете
 * CLAUDE_API_KEY и всё равно осталось зелёным — экшен на отказ API пишет
 * {"error": …} и выходит с 0. Решение владельца того же дня: ревью на
 * основном ключе ANTHROPIC_API_KEY; «не смог» — красный (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, stepByName, evalIf } from '../helpers/workflow-semantics';

const wf = loadWorkflow('.github/workflows/security-review.yml');
const job = wf.jobs.review;
const review = stepByName(job, 'Claude security review');
const verdict = stepByName(job, 'Ревью состоялось');
const skip = stepByName(job, 'Ключ не задан — пропуск');

const withKey = { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } };
const noKey = { env: { ANTHROPIC_API_KEY: '' } };

/** Шаг «Ревью состоялось» на подложенном итоге экшена; null — файла нет. */
function runVerdict(results: string | null): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secrev-'));
  try {
    if (results !== null) writeFileSync(join(dir, 'claudecode-results.json'), results);
    const r = spawnSync('bash', ['-e', '-c', verdict.run ?? ''], { cwd: dir, encoding: 'utf-8' });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('security-review: ключ', () => {
  it('ревью идёт на основном ключе ANTHROPIC_API_KEY, отдельного CLAUDE_API_KEY нет', () => {
    expect(review.uses).toMatch(/^anthropics\/claude-code-security-review@[0-9a-f]{40}$/);
    const inputs = (review as { with?: Record<string, string> }).with ?? {};
    // С 03.11 провайдер переключаемый: AGENTS_PROVIDER=anthropic — Console,
    // иначе OpenRouter (Anthropic отвечал 403 verification_required).
    expect(inputs['claude-api-key']).toBe('${{ env.ANTHROPIC_API_KEY }}');
    const env = (job as { env?: Record<string, string> }).env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe("${{ vars.AGENTS_PROVIDER == 'anthropic' && secrets.ANTHROPIC_API_KEY || secrets.OPENROUTER_API_KEY }}");
    expect(env.ANTHROPIC_BASE_URL).toBe("${{ vars.AGENTS_PROVIDER == 'anthropic' && 'https://api.anthropic.com' || 'https://openrouter.ai/api' }}");
    expect(JSON.stringify(wf)).not.toContain('CLAUDE_API_KEY');
  });

  it('без ключа ревью и проверка итога не идут, идёт мягкий пропуск', () => {
    expect(evalIf(review.if, noKey)).toBe(false);
    expect(evalIf(verdict.if, noKey)).toBe(false);
    expect(evalIf(skip.if, noKey)).toBe(true);
  });

  it('с ключом идут ревью и проверка итога, пропуска нет', () => {
    expect(evalIf(review.if, withKey)).toBe(true);
    expect(evalIf(verdict.if, withKey)).toBe(true);
    expect(evalIf(skip.if, withKey)).toBe(false);
  });

  it('проверка итога стоит после ревью', () => {
    const names = (job.steps ?? []).map((s) => s.name);
    expect(names.indexOf('Ревью состоялось')).toBeGreaterThan(names.indexOf('Claude security review'));
  });
});

describe('security-review: настройки проекта ревьюеру не достаются', () => {
  const strip = stepByName(job, 'Настройки Claude Code репозитория — не ревьюеру');

  it('после checkout и до ревью, при том же условии, что ревью', () => {
    const names = (job.steps ?? []).map((s) => s.name);
    expect(names.indexOf('Настройки Claude Code репозитория — не ревьюеру'))
      .toBeGreaterThan(names.indexOf('Checkout (с базой для диффа)'));
    expect(names.indexOf('Настройки Claude Code репозитория — не ревьюеру'))
      .toBeLessThan(names.indexOf('Claude security review'));
    expect(evalIf(strip.if, withKey)).toBe(true);
    expect(evalIf(strip.if, noKey)).toBe(false);
  });

  it('шаг убирает settings.json, settings.local.json и CLAUDE.md, прочее остаётся; без файлов не падает', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrev-strip-'));
    try {
      const claude = join(dir, '.claude');
      mkdirSync(claude);
      writeFileSync(join(claude, 'settings.json'), '{"permissions":{"allow":["Bash(curl -s *)"]}}');
      writeFileSync(join(claude, 'settings.local.json'), '{}');
      writeFileSync(join(claude, 'MEMORY.md'), 'заметки');
      // CLAUDE.md Claude Code кладёт в контекст сам и перечитывает на каждом
      // ходу: 220 КБ истории проекта на каждом ревью (разбор расхода 07.11).
      writeFileSync(join(dir, 'CLAUDE.md'), '# правила проекта');
      writeFileSync(join(dir, 'README.md'), 'readme');
      const r = spawnSync('bash', ['-e', '-c', strip.run ?? ''], { cwd: dir, encoding: 'utf-8' });
      expect(r.status).toBe(0);
      expect(existsSync(join(claude, 'settings.json'))).toBe(false);
      expect(existsSync(join(claude, 'settings.local.json'))).toBe(false);
      expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
      expect(existsSync(join(dir, 'README.md'))).toBe(true);
      expect(existsSync(join(claude, 'MEMORY.md'))).toBe(true);
      expect(spawnSync('bash', ['-e', '-c', strip.run ?? ''], { cwd: dir, encoding: 'utf-8' }).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('security-review: «не смог» — красный (§4.0)', () => {
  it('отказ API ({"error": …}, ответ 16.10) — красный, причина одной строкой', () => {
    const r = runVerdict(JSON.stringify({ error: 'Security audit failed: Claude Code execution failed\nStdout: Invalid API key · Fix external API key' }));
    expect(r.code).toBe(1);
    const line = r.out.split('\n').find((l) => l.startsWith('::error::'));
    expect(line).toContain('Ревью безопасности не состоялось');
    expect(line).toContain('Invalid API key');
    // Перевод строки из текста ошибки не начал новую строку вывода — не мог стать новой командой workflow.
    expect(r.out.split('\n').some((l) => l.startsWith('Stdout:'))).toBe(false);
  });

  it('итога нет или он пуст — красный, а не «находок нет»', () => {
    expect(runVerdict(null).code).toBe(1);
    expect(runVerdict('').code).toBe(1);
    expect(runVerdict(null).out).toContain('не оставило итога');
  });

  it('итог не JSON-объект — красный', () => {
    expect(runVerdict('not json').code).toBe(1);
    expect(runVerdict('[1,2]').code).toBe(1);
  });

  it('ревью состоялось — зелёный и с находками, и без них', () => {
    const none = runVerdict(JSON.stringify({ findings: [] }));
    expect(none.code).toBe(0);
    expect(none.out).toContain('находок: 0');
    const two = runVerdict(JSON.stringify({ findings: [{ title: 'a' }, { title: 'b' }] }));
    expect(two.code).toBe(0);
    expect(two.out).toContain('находок: 2');
  });
});

describe('security-review: одно ревью при открытии, свежее — по метке (07.11)', () => {
  const types = ((wf.on as { pull_request?: { types?: string[] } }).pull_request?.types) ?? [];
  const inputs = (review as { with?: Record<string, string | boolean> }).with ?? {};

  it('прогона при выводе из черновика нет: экшен его всё равно не делал и краснел пустым итогом', () => {
    expect(types).toContain('opened');
    expect(types).toContain('labeled');
    expect(types).not.toContain('ready_for_review');
  });

  it('по метке ревью настоящее: экшен не отказывается от второго ревью того же PR', () => {
    // Без этого экшен находит в кэше метку прошлого ревью и модель не зовёт.
    expect(inputs['run-every-commit']).toBe(true);
  });

  it('модель — Opus 5, не 5.5: экшен ставит Claude Code из npm (2.1.197), а Opus 5.5 принимается от 2.1.280', () => {
    // Прогон на PR #3083 (07.11): «API Error: 400 Claude Code 2.1.197 does not
    // support this model». Когда экшен научится ставить свежий Claude Code —
    // перевести и ревьюера, вместе с этой строкой.
    expect(inputs['claude-model']).toBe("${{ vars.AGENTS_PROVIDER == 'anthropic' && 'claude-opus-5' || 'anthropic/claude-opus-5' }}");
  });
});

describe('security-review: триггер и права', () => {
  it('pull_request, не pull_request_target — форки не получают секрет', () => {
    expect(Object.keys(wf.on)).toContain('pull_request');
    expect(Object.keys(wf.on)).not.toContain('pull_request_target');
  });

  it('постит комментарии на PR (совещательный режим)', () => {
    const inputs = (review as { with?: Record<string, string | boolean> }).with ?? {};
    expect(inputs['comment-pr']).toBe(true);
  });

  it('минимально необходимые права', () => {
    const perms = (wf as unknown as { permissions?: Record<string, string> }).permissions ?? {};
    expect(perms).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });

  it('ревью по метке — только по своей', () => {
    const labeled = (name: string) => ({ github: { event: { action: 'labeled', label: { name } } } });
    expect(evalIf(job.if, labeled('security-review'))).toBe(true);
    expect(evalIf(job.if, labeled('triaged'))).toBe(false);
    expect(evalIf(job.if, { github: { event: { action: 'opened' } } })).toBe(true);
  });
});
