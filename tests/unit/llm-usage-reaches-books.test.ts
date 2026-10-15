/**
 * Сторож: расход, потраченный на раннере, доходит до книг платформы.
 *
 * ── Что было (прогон evo-judge 53, 19.09 13:56) ──────────────────────────
 *
 *   13:56:05 Счёт OpenRouter: осталось $18.83
 *   13:56:15 [llm-usage] каталог моделей не прочитан: z-ai/glm-5.3
 *   13:56:15 [llm-usage] строка не записана: z-ai/glm-5.3
 *   13:56:44 [llm-usage] каталог моделей не прочитан: deepseek-v4-pro
 *   13:56:44 [llm-usage] строка не записана: deepseek-v4-pro
 *   13:56:46 [llm-usage] каталог моделей не прочитан: z-ai/glm-5.3
 *   13:56:46 [llm-usage] строка не записана: z-ai/glm-5.3
 *
 * Флагман РАБОТАЛ: GLM 5.3 ответил дважды, находка разобрана, решение
 * опубликовано. Не работал учёт — ни один из трёх вызовов не оставил в
 * `llm_usage_log` ни строки.
 *
 * Механизм сломан не был: `lib/ai/usage-sink.ts` написан ровно под это —
 * БД Timeweb с раннера закрыта файрволом, поэтому расход уходит на прод
 * роутом. Но включается он ТОЛЬКО при `CRON_SECRET`, а в env шага
 * «Judge with strong model» стояли пять ключей провайдеров и ни одного
 * `CRON_SECRET`. То есть механизм был объявлен и не подключён — §10.09 в
 * чистом виде, и заметить это можно было только по логу прогона, который
 * никто не читает.
 *
 * Цена: `/api/cron/llm-budget-check` суммирует `llm_usage_log`. По тратам
 * двух самых дорогих потребителей платформы (судья и AI-ревью) дневной
 * бюджет не мог сработать ни при каком `AI_DAILY_BUDGET_USD` — складывать
 * было нечего.
 *
 * ── Что держит сторож ────────────────────────────────────────────────────
 *
 * Связку целиком, а не половину: список скриптов, доходящих до `logLLMUsage`,
 * считается ПО ИМПОРТАМ, а не пишется руками, — значит новый скрипт, начавший
 * звать модель, попадает под правило сам. Для каждого такого скрипта
 * проверяется env ТОГО шага, который его запускает: `CRON_SECRET`,
 * объявленный этажом выше в соседнем шаге, вызову недоступен.
 *
 * ── Руки (аудит 15.10, AC-1) ─────────────────────────────────────────────
 *
 * claude-code-action зовёт модель сам, мимо `logLLMUsage`, и обход импортов
 * его не видит. Руки находятся ПО ШАГУ ЭКШЕНА в workflow — новая рука
 * попадает под правило сама. Для каждой: файл выполнения уезжает артефактом
 * при любом исходе шага, учёт идёт ОТДЕЛЬНОЙ работой с `CRON_SECRET` и
 * скриптом из main, а в работе с агентом секрета нет (у агента Bash на её
 * раннере). Разбор файла выполнения и отправка — исполнением на образце
 * (tests/fixtures/hands), приёмник — вызовом с полями кэша: цена с
 * множителями, а не вход без кэша.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { POST as reportUsage } from '@/app/api/admin/llm-usage/report/route';
import {
  ANTHROPIC_CACHE_READ_MULTIPLIER,
  ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER,
} from '@/lib/ai/cache-pricing';
import { parseExecution, runHandsUsage } from '../../scripts/hands-usage.mjs';

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, '.github/workflows');

// ── Кто доходит до журнала расхода ──────────────────────────────────────

/** `@/x/y` → файл на диске, или null для внешнего пакета. */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  const base = join(ROOT, spec.slice(2));
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Доходит ли `entry` по импортам до модуля провайдеров.
 *
 * Разбор регулярным выражением намеренно грубый и намеренно НЕ отличает
 * `import type`: ошибиться здесь можно только в сторону лишней строгости —
 * шаг получит секрет, который ему не нужен. Обратная ошибка молчалива и
 * стоит месяца пустых книг.
 */
function reachesProviders(entry: string): boolean {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('lib/ai/providers.ts')) return true;
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/from\s+'(@\/[^']+)'/g)) {
      const r = resolveAlias(m[1]);
      if (r) stack.push(r);
    }
  }
  return false;
}

/** Скрипты, чей прогон способен сжечь токены. Считается, а не перечисляется. */
function spendingScripts(): string[] {
  return readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => reachesProviders(join(ROOT, 'scripts', f)));
}

// ── Разбор workflow ─────────────────────────────────────────────────────

interface Step { name?: string; run?: string; env?: Record<string, unknown> }
interface Job { steps?: Step[] }

/** Шаги всех workflow, чей `run` запускает один из переданных скриптов. */
function stepsRunning(scripts: readonly string[]): Array<{ file: string; step: string; env: Record<string, unknown> }> {
  const out: Array<{ file: string; step: string; env: Record<string, unknown> }> = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const doc = load(readFileSync(join(WORKFLOWS, file), 'utf-8')) as { jobs?: Record<string, Job> } | null;
    for (const job of Object.values(doc?.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const run = step.run ?? '';
        if (!scripts.some((s) => run.includes(`scripts/${s}`))) continue;
        out.push({ file, step: step.name ?? '(без имени)', env: (step.env ?? {}) as Record<string, unknown> });
      }
    }
  }
  return out;
}

describe('скрипты, жгущие токены, находятся по импортам', () => {
  it('такие скрипты есть, и разбор их видит', () => {
    // Провал разбора (переименовали алиас, сменили кавычки) обязан краснеть,
    // а не выдавать пустой список за «нарушителей нет» (§4.0).
    const scripts = spendingScripts();
    expect(scripts.length, 'ни одного скрипта не нашлось — сломался обход импортов').toBeGreaterThan(0);
    expect(scripts).toContain('evo-judge.ts');
    expect(scripts).toContain('evo-review.ts');
  });

  it('у каждого есть шаг, который его запускает', () => {
    for (const s of spendingScripts()) {
      const steps = stepsRunning([s]);
      expect(steps.length, `${s} не запускается ни одним workflow`).toBeGreaterThan(0);
    }
  });
});

describe('расход раннера доходит до книг', () => {
  it('шаг, зовущий модель, несёт CRON_SECRET', () => {
    // Главное свойство. Без секрета usageSinkEnabled() ложно, и строка уходит
    // прямым INSERT в БД, которой с раннера нет.
    const bad = stepsRunning(spendingScripts())
      .filter((s) => !('CRON_SECRET' in s.env))
      .map((s) => `${s.file} → ${s.step}`);
    expect(bad, `расход этих шагов в книги не попадёт: ${bad.join(', ')}`).toEqual([]);
  });

  it('секрет берётся из секретов репозитория, а не зашит', () => {
    for (const s of stepsRunning(spendingScripts())) {
      expect(String(s.env.CRON_SECRET), `${s.file} → ${s.step}`).toMatch(/secrets\.CRON_SECRET/);
    }
  });

  it('шаг несёт и ключ модели — иначе секрет сторожит пустоту', () => {
    // Связка, а не половина (§10.09): CRON_SECRET без ключа провайдера
    // означал бы шаг, который ничего не тратит и потому ничего не пишет.
    for (const s of stepsRunning(spendingScripts())) {
      const keys = Object.keys(s.env).filter((k) => k.endsWith('_API_KEY'));
      expect(keys.length, `${s.file} → ${s.step}: ни одного ключа провайдера`).toBeGreaterThan(0);
    }
  });
});

describe('сток расхода включается фактами, а не настройкой', () => {
  const SINK = readFileSync(join(ROOT, 'lib/ai/usage-sink.ts'), 'utf-8');
  const PROVIDERS = readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8');

  it('оба условия обязательны: раннер И секрет', () => {
    expect(SINK).toMatch(/GITHUB_ACTIONS === 'true' && Boolean\(process\.env\.CRON_SECRET\)/);
  });

  it('адрес прода зашит, а не приходит переменной', () => {
    // Урок 08.08: правило, зависящее от дисциплины заполняющего конфиг, — не
    // защита. Секрет ходит на один известный адрес.
    expect(SINK).toContain("const PROD_BASE = 'https://vedarai.ru'");
    expect(SINK).not.toMatch(/process\.env\.\w*PROD\w*/);
  });

  it('журнал выбирает сток, а не пишет мимо него', () => {
    const at = PROVIDERS.indexOf('async function logLLMUsage');
    expect(at, 'logLLMUsage не найден').toBeGreaterThan(0);
    const body = PROVIDERS.slice(at, at + 1800);
    expect(body).toContain('if (usageSinkEnabled())');
    // Ветка стока ЗАВЕРШАЕТ функцию — иначе следом пошёл бы заведомо
    // падающий INSERT и вернул бы в лог то самое «строка не записана».
    const sinkAt = body.indexOf('if (usageSinkEnabled())');
    expect(body.slice(sinkAt, sinkAt + 300)).toMatch(/sendUsageToProd\([\s\S]*?\);\s*\n\s*return;/);
  });
});

describe('недостижимый каталог цен не выдаётся за поломку', () => {
  const PROVIDERS = readFileSync(join(ROOT, 'lib/ai/providers.ts'), 'utf-8');

  it('в базу не ходят, когда строки подключения нет вовсе', () => {
    // На раннере DATABASE_URL не задан: это известное состояние, а не отказ.
    // Тревога «каталог моделей не прочитан» на каждый вызов 19.09 увела
    // разбор немоты флагмана в сторону БД, хотя сломан был сток расхода.
    expect(PROVIDERS).toMatch(/function priceCatalogReachable\(\): boolean \{\s*\n\s*return Boolean\(process\.env\.DATABASE_URL\);/);
    const at = PROVIDERS.indexOf('export async function resolveCostUsd');
    const head = PROVIDERS.slice(at, at + 400);
    expect(head).toContain('if (!priceCatalogReachable()) return fromCostTable(candidates);');
    // Проверка стоит ДО try с запросом, а не внутри.
    expect(head.indexOf('priceCatalogReachable()')).toBeLessThan(head.indexOf('pool.query'));
  });

  it('настоящий отказ каталога по-прежнему говорит вслух', () => {
    // Молчать нельзя (§4.0): недостижимость — известна, а упавший запрос —
    // нет, и это разные вещи.
    expect(PROVIDERS).toContain('[llm-usage] каталог моделей не прочитан:');
  });

  it('незнание цены остаётся незнанием, а не нулём', () => {
    const at = PROVIDERS.indexOf('function fromCostTable');
    expect(at, 'запасной таблицы нет').toBeGreaterThan(0);
    expect(PROVIDERS.slice(at, at + 600)).toContain("return { cost: null, basis: 'unknown' }");
  });
});

// ── Руки: claude-code-action (аудит 15.10, AC-1) ────────────────────────

interface WfStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface WfJob {
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  steps?: WfStep[];
}
interface WfDoc { env?: Record<string, unknown>; jobs?: Record<string, WfJob> }

const HAND_ACTION = 'anthropics/claude-code-action@';
const BOOKS_SCRIPT = 'scripts/hands-usage.mjs';

interface Hand { file: string; doc: WfDoc; jobId: string; job: WfJob; step: WfStep; stepIndex: number }

/** Руки находятся по шагу экшена, а не списком: новая рука попадает под правило сама. */
function hands(): Hand[] {
  const out: Hand[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const doc = load(readFileSync(join(WORKFLOWS, file), 'utf-8')) as WfDoc | null;
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
      (job.steps ?? []).forEach((step, stepIndex) => {
        if (step.uses?.startsWith(HAND_ACTION)) out.push({ file, doc: doc as WfDoc, jobId, job, step, stepIndex });
      });
    }
  }
  return out;
}

const needsOf = (job: WfJob): string[] => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);

/** Работа учёта руки: зависит от работы руки и запускает скрипт учёта. */
function booksJob(h: Hand): { jobId: string; job: WfJob; step: WfStep } | null {
  for (const [jobId, job] of Object.entries(h.doc.jobs ?? {})) {
    if (!needsOf(job).includes(h.jobId)) continue;
    const step = (job.steps ?? []).find((s) => (s.run ?? '').includes(BOOKS_SCRIPT));
    if (step) return { jobId, job, step };
  }
  return null;
}

describe('руки находятся по шагу экшена', () => {
  it('все четыре известные руки видны разбору', () => {
    // Провал разбора (сменился формат uses, переименовали экшен) обязан
    // краснеть, а не выдавать пустой список за «нарушителей нет» (§4.0).
    const files = hands().map((h) => h.file);
    for (const f of ['claude.yml', 'issue-triage.yml', 'ci-sweeper.yml', 'weekly-chronicle.yml']) {
      expect(files, `${f}: шаг руки не найден`).toContain(f);
    }
  });
});

describe('расход рук доходит до книг', () => {
  for (const h of hands()) {
    const id = h.step.id ?? '';

    it(`${h.file}: шаг руки назван, исход и файл выполнения выходят из работы`, () => {
      expect(id, 'у шага руки нет id — учёту не на что сослаться').not.toBe('');
      expect(h.job.outputs?.hand_outcome).toBe(`\${{ steps.${id}.outcome }}`);
      expect(h.job.outputs?.execution_file).toBe(`\${{ steps.${id}.outputs.execution_file }}`);
    });

    it(`${h.file}: файл выполнения уезжает при ЛЮБОМ исходе руки`, () => {
      const upload = (h.job.steps ?? [])
        .slice(h.stepIndex + 1)
        .find((s) => (s.uses ?? '').startsWith('actions/upload-artifact@'));
      expect(upload, 'после руки нет загрузки файла выполнения').toBeDefined();
      // Упавший или оборванный прогон тоже тратил — без always() его расход
      // не доехал бы до книг ровно тогда, когда он самый непредсказуемый.
      expect(upload?.if ?? '').toMatch(/always\(\)/);
      expect(String(upload?.with?.path ?? '')).toContain(`steps.${id}.outputs.execution_file`);
      const books = booksJob(h);
      const download = (books?.job.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/download-artifact@'));
      expect(download?.with?.name, 'учёт скачивает не тот артефакт').toBe(upload?.with?.name);
    });

    it(`${h.file}: учёт — своя работа, при любом исходе руки, с CRON_SECRET`, () => {
      const books = booksJob(h);
      expect(books, `нет работы, запускающей ${BOOKS_SCRIPT} после ${h.jobId}`).not.toBeNull();
      expect(books?.job.if ?? '').toMatch(/always\(\)/);
      expect(books?.job.if ?? '').toContain(`needs.${h.jobId}.outputs.hand_outcome`);
      expect(books?.step.if ?? '').toMatch(/always\(\)/);
      const env = books?.step.env ?? {};
      expect(String(env.CRON_SECRET)).toMatch(/^\$\{\{ secrets\.CRON_SECRET \}\}$/);
      // agent_id — имя workflow: по нему видно в книгах, какая рука потратила.
      expect(env.AGENT_ID).toBe(h.file.replace(/\.ya?ml$/, ''));
      expect(String(env.HAND_EXECUTION_FILE)).toContain(`needs.${h.jobId}.outputs.execution_file`);
    });

    it(`${h.file}: скрипт учёта — из main, а не из рабочей копии руки`, () => {
      const books = booksJob(h);
      const checkout = (books?.job.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
      expect(checkout?.with?.ref, 'учёт с секретом исполнял бы код ветки, которую могла тронуть рука').toBe('main');
      expect(books?.job.permissions).toEqual({ contents: 'read' });
      expect((books?.job.steps ?? []).some((s) => (s.uses ?? '').startsWith(HAND_ACTION))).toBe(false);
    });

    it(`${h.file}: в работе с агентом CRON_SECRET нет`, () => {
      // Запрет. У агента Bash на раннере своей работы, а триаж читает тексты
      // чужих issues: секрет, открывающий /api/admin/* на проде, туда не идёт.
      expect(JSON.stringify(h.job)).not.toContain('CRON_SECRET');
      expect(JSON.stringify(h.doc.env ?? {})).not.toContain('CRON_SECRET');
    });
  }
});

// ── Разбор файла выполнения — исполнением на образце ────────────────────

const FIXTURE = join(ROOT, 'tests/fixtures/hands/claude-execution-output.json');
const fixtureMessages = (): unknown[] => JSON.parse(readFileSync(FIXTURE, 'utf-8')) as unknown[];

describe('разбор файла выполнения руки', () => {
  it('итог прогона: строки по моделям, с кэшем, ключ журнала — прямой Anthropic', () => {
    const parsed = parseExecution(fixtureMessages());
    expect(parsed.form).toBe('result');
    expect(parsed.reportedCostUsd).toBe(0.4);
    expect(parsed.rows).toEqual([
      {
        model: 'anthropic:claude-hand-model',
        prompt_tokens: 20,
        completion_tokens: 495,
        cache_creation_tokens: 45000,
        cache_read_tokens: 40000,
      },
      {
        model: 'anthropic:claude-helper-model',
        prompt_tokens: 900,
        completion_tokens: 40,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
      },
    ]);
  });

  it('обрыв без итога: ответы модели, каждый ответ — один раз', () => {
    // При потоковой выдаче один ответ модели приходит несколькими
    // сообщениями с той же usage. Сумма по сообщениям дала бы выход 498 и
    // запись в кэш 85000 — первый ответ посчитан дважды.
    const parsed = parseExecution(fixtureMessages().filter((m) => (m as { type?: string }).type !== 'result'));
    expect(parsed.form).toBe('assistant');
    expect(parsed.reportedCostUsd).toBeNull();
    expect(parsed.rows).toEqual([
      {
        model: 'anthropic:claude-hand-model',
        prompt_tokens: 20,
        completion_tokens: 495,
        cache_creation_tokens: 45000,
        cache_read_tokens: 40000,
      },
    ]);
  });

  it('незнакомая форма — «не разобран» с причиной, а не ноль', () => {
    for (const bad of [{ messages: [] }, [], [{ type: 'system' }], [{ type: 'result', total_cost_usd: 1 }]]) {
      const parsed = parseExecution(bad);
      expect(parsed.form).toBe('unknown');
      expect(parsed.rows).toEqual([]);
      expect(parsed.reason).toBeTruthy();
    }
    const brokenUsage = parseExecution([{ type: 'result', modelUsage: { m: { inputTokens: '20', outputTokens: 1 } } }]);
    expect(brokenUsage.form).toBe('unknown');
  });

  it('кэш не сообщён — null, а не ноль', () => {
    const parsed = parseExecution([{ type: 'result', modelUsage: { m: { inputTokens: 5, outputTokens: 1 } } }]);
    expect(parsed.rows[0]).toMatchObject({ cache_creation_tokens: null, cache_read_tokens: null });
  });
});

describe('учёт прогона руки: отправка и исходы', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hands-usage-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const okResponse = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('строки уходят на прод с секретом, agent_id и кэшем; заявление экшена — только в сводку', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return okResponse({ ok: true, written: 2, failed: 0, unknown_cost: 0, cost_usd_known: 0.39 });
    }) as unknown as typeof fetch;
    const res = await runHandsUsage({
      env: { AGENT_ID: 'issue-triage', CRON_SECRET: 's3cret', EXECUTION_FILE: FIXTURE, HAND_EXECUTION_FILE: '/tmp/x.json' },
      fetchImpl,
    });
    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://vedarai.ru/api/admin/llm-usage/report');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
    const body = JSON.parse(String(calls[0].init.body)) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      model: 'anthropic:claude-hand-model',
      prompt_tokens: 20,
      completion_tokens: 495,
      cache_creation_tokens: 45000,
      cache_read_tokens: 40000,
      agent_id: 'issue-triage',
    });
    // Цену в книги клиент не шлёт: ни своей, ни заявленной экшеном.
    expect(JSON.stringify(body)).not.toMatch(/cost/i);
    expect(res.summary).toContain('$0.4000');
    expect(res.summary).toContain('$0.3900');
  });

  it('книги и экшен разошлись — сказано вслух', async () => {
    const fetchImpl = (async () => okResponse({ written: 2, unknown_cost: 0, cost_usd_known: 0.1 })) as unknown as typeof fetch;
    const res = await runHandsUsage({ env: { AGENT_ID: 'claude', CRON_SECRET: 's', EXECUTION_FILE: FIXTURE }, fetchImpl });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toMatch(/::warning::.*расходятся/);
  });

  it('прод записал не всё (207) — ошибка, а не успех', async () => {
    const fetchImpl = (async () => okResponse({ ok: false, written: 1, failed: 1 }, 207)) as unknown as typeof fetch;
    const res = await runHandsUsage({ env: { AGENT_ID: 'claude', CRON_SECRET: 's', EXECUTION_FILE: FIXTURE }, fetchImpl });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toMatch(/::error::.*HTTP 207/);
  });

  it('нет секрета — ошибка: расход есть, а в книги не попадёт', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await runHandsUsage({ env: { AGENT_ID: 'claude', EXECUTION_FILE: FIXTURE }, fetchImpl });
    expect(res.exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('файла нет, экшен его и не называл — «расход неизвестен», не ошибка', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await runHandsUsage({ env: { AGENT_ID: 'claude', CRON_SECRET: 's', EXECUTION_FILE: join(dir, 'нет.json') }, fetchImpl });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toMatch(/::warning::.*неизвестен/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('экшен файл назвал, а до учёта он не доехал — потеря, ошибка', async () => {
    const res = await runHandsUsage({
      env: { AGENT_ID: 'claude', CRON_SECRET: 's', EXECUTION_FILE: join(dir, 'нет.json'), HAND_EXECUTION_FILE: '/home/runner/work/_temp/claude-execution-output.json' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(res.exitCode).toBe(1);
    expect(res.out.join('\n')).toMatch(/::error::/);
  });

  it('незнакомая форма файла — предупреждение «не разобран», в прод ничего не идёт', async () => {
    const file = join(dir, 'odd.json');
    writeFileSync(file, JSON.stringify({ transcript: [] }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await runHandsUsage({ env: { AGENT_ID: 'claude', CRON_SECRET: 's', EXECUTION_FILE: file }, fetchImpl });
    expect(res.exitCode).toBe(0);
    expect(res.out.join('\n')).toMatch(/::warning::.*не разобран/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('скрипт исполняется голым node с флагом --run — как в работе учёта', () => {
    // В работе учёта нет ни npm ci, ни tsx: только node и файл из main.
    const file = join(dir, 'odd.json');
    writeFileSync(file, '{"not": "an array"}');
    const run = spawnSync(process.execPath, [join(ROOT, BOOKS_SCRIPT), '--run'], {
      env: { PATH: process.env.PATH ?? '', AGENT_ID: 'claude', EXECUTION_FILE: file },
      encoding: 'utf-8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/::warning::.*не разобран/);
  });
});

// ── Приёмник: цена кэша считается на сервере ────────────────────────────

describe('приёмник расхода: кэш подсказок', () => {
  const saved: Record<string, string | undefined> = {};
  const IN_PRICE = 5;
  const OUT_PRICE = 25;

  beforeEach(() => {
    for (const k of ['CRON_SECRET', 'DATABASE_URL']) saved[k] = process.env[k];
    process.env.CRON_SECRET = 'books-secret';
    // Ветка с каталогом цен: на проде строка подключения есть.
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM model_catalog')) {
        return { rows: [{ usd_per_mtok_in: String(IN_PRICE), usd_per_mtok_out: String(OUT_PRICE) }] };
      }
      return { rows: [], rowCount: 1 };
    });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const post = (rows: unknown[]) => reportUsage(new NextRequest('http://localhost/api/admin/llm-usage/report', {
    method: 'POST',
    headers: { Authorization: 'Bearer books-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  }));
  const inserts = () => queryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO llm_usage_log'));

  it('запись и чтение кэша — по множителям от цены входа', async () => {
    const res = await post([{
      model: 'anthropic:claude-hand-model',
      prompt_tokens: 1000,
      completion_tokens: 200,
      cache_creation_tokens: 10_000,
      cache_read_tokens: 100_000,
      agent_id: 'claude',
    }]);
    expect(res.status).toBe(200);
    const expected = (
      1000 * IN_PRICE
      + 10_000 * IN_PRICE * ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER
      + 100_000 * IN_PRICE * ANTHROPIC_CACHE_READ_MULTIPLIER
      + 200 * OUT_PRICE
    ) / 1e6;
    // Множители — из документации Anthropic, а не подобраны под тест.
    expect(ANTHROPIC_CACHE_WRITE_5M_MULTIPLIER).toBe(1.25);
    expect(ANTHROPIC_CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(expected).toBeCloseTo(0.1225, 10);
    const [[, params]] = inserts() as Array<[string, unknown[]]>;
    expect(params[0]).toBe('anthropic:claude-hand-model');
    expect(params[1]).toBe(1000);
    expect(params[2]).toBe(200);
    expect(params[3]).toBe(1200); // total_tokens — вход + выход, как с 686
    expect(params[4] as number).toBeCloseTo(expected, 10);
    expect(params[5]).toBe('model_catalog');
    expect(params[6]).toBe('claude');
    expect(params.slice(7)).toEqual([10_000, 100_000]);
    const body = await res.json() as { written: number; cost_usd_known: number };
    expect(body.written).toBe(1);
    expect(body.cost_usd_known).toBeCloseTo(expected, 6);
  });

  it('прежний звонящий без полей кэша — цена как раньше, колонки кэша NULL', async () => {
    const res = await post([{ model: 'othervendor/some-model', prompt_tokens: 1000, completion_tokens: 200, agent_id: 'evo-judge' }]);
    expect(res.status).toBe(200);
    const [[, params]] = inserts() as Array<[string, unknown[]]>;
    expect(params[4] as number).toBeCloseTo((1000 * IN_PRICE + 200 * OUT_PRICE) / 1e6, 10);
    expect(params.slice(7)).toEqual([null, null]);
  });

  it('кэш у вендора, чьих множителей мы не знаем, — цена неизвестна, а не вход без кэша', async () => {
    const res = await post([{ model: 'othervendor:some-model', prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 5000 }]);
    expect(res.status).toBe(200);
    const [[, params]] = inserts() as Array<[string, unknown[]]>;
    expect(params[4]).toBeNull();
    expect(params[5]).toBe('unknown');
    const body = await res.json() as { unknown_cost: number };
    expect(body.unknown_cost).toBe(1);
  });

  it('строка из одного чтения кэша — трата, а не пустая строка', async () => {
    await post([{ model: 'anthropic:claude-hand-model', prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 1000 }]);
    expect(inserts()).toHaveLength(1);
  });

  it('отрицательный кэш отвергается схемой', async () => {
    const res = await post([{ model: 'anthropic:m', prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: -5 }]);
    expect(res.status).toBe(400);
    expect(inserts()).toHaveLength(0);
  });
});
