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
 * попадает под правило сама. Для каждой: при любом исходе шага артефактом
 * уезжает ВЫЖИМКА файла выполнения — одни счётчики, а не транскрипт агента
 * (ревью AC-1: репозиторий публичный, маски секретов в артефакте нет);
 * учёт идёт ОТДЕЛЬНОЙ работой с `CRON_SECRET` и скриптом из main, а в
 * работе с агентом секрета нет (у агента Bash на её раннере). Выжимка —
 * исполнением шага workflow на транскрипте с подложенным секретом; разбор и
 * отправка — исполнением на образце (tests/fixtures/hands), приёмник —
 * вызовом с полями кэша: цена с множителями, а не вход без кэша.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import ts from 'typescript';
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
import { LLM_ENDPOINTS } from '@/lib/agents/compliance/provider-registry';
import { reportUsageNow, usageRowFromAnthropic, usageRowFromResponse } from '@/lib/ai/usage-sink';
import { priceLookupIds } from '@/lib/ai/providers';

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

// ── Прямые вызовы модели из раннера (07.11) ─────────────────────────────
//
// Обход импортов выше видит только тех, кто идёт через providers.ts. Скрипт со
// своим fetch к модели до logLLMUsage не доходит вовсе: так Editor на раннере
// (OpenRouter, Opus по умолчанию, каждый день) ни разу не попал в книги, и
// дневной бюджет его трат не видел. Такие скрипты находятся по адресу модели из
// реестра D2 в их коде; каждый пишет расход сам (usage-sink, CRON_SECRET в шаге)
// или назван ниже с причиной. Список только сокращается: скрипт начал писать
// расход или перестал звать модель — запись убрать.
//
// Адрес ищется в строковых литералах РАЗБОРОМ (TypeScript), а не в тексте с
// вырезанными регэкспом комментариями (ревью безопасности #3144): строка
// 'text/html,*/*' открывала «комментарий» до первого */ и прятала за ним
// настоящий fetch к api.anthropic.com в unique-routes-scraper.js.
const DIRECT_CALLERS_OUTSIDE_BOOKS: Record<string, string> = {
  'model-catalog-runner.ts': 'читает каталог /models OpenRouter — токенов не тратит',
  'list-ai-models.js': 'читает списки /models у провайдеров — токенов не тратит; ни одним workflow не запускается',
  'astra-probe.ts': 'очная ставка моделей по маркеру (проба); расход в книги не пишет — перевести на usage-sink',
  'qwen-image-probe.ts': 'проба обложек Qwen-Image по маркеру; расход в книги не пишет',
  'qwen-key-probe.ts': 'проба ключа DashScope по маркеру; расход в книги не пишет',
  'xai-x-search-probe.ts': 'проба x_search по маркеру; расход в книги не пишет',
  'route-scraper-agent.js': 'локальный скрипт из package.json, ни одним workflow не запускается — расход на ключе запускающего',
  'scrape-operator-tours.js': 'локальный скрипт, ни одним workflow не запускается — расход на ключе запускающего',
  'unique-routes-scraper.js': 'локальный скрипт из package.json, ни одним workflow не запускается — расход на ключе запускающего',
};

const SCRIPTS_DIR = join(ROOT, 'scripts');
const LLM_HOSTS = LLM_ENDPOINTS.map((e) => e.host);

function scriptFiles(dir = SCRIPTS_DIR, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) scriptFiles(full, out);
    else if (/\.(ts|mjs|js|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

interface CodeFacts { hosts: string[]; importsUsageSink: boolean; callsSendUsage: boolean }

/** Что скрипт делает В КОДЕ — по дереву разбора: комментарии туда не входят, строки входят целиком. */
function codeFacts(src: string, fileName: string): CodeFacts {
  const kind = /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const hosts = new Set<string>();
  const facts: CodeFacts = { hosts: [], importsUsageSink: false, callsSendUsage: false };
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      for (const h of LLM_HOSTS) if (n.text.includes(h)) hosts.add(h);
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /(^|\/)lib\/ai\/usage-sink$/.test(n.moduleSpecifier.text)) {
      facts.importsUsageSink = true;
    }
    // Отправка — sendUsageToProd или reportUsageNow (строка одного ответа сразу).
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
      && (n.expression.text === 'sendUsageToProd' || n.expression.text === 'reportUsageNow')) {
      facts.callsSendUsage = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  facts.hosts = [...hosts].sort();
  return facts;
}

/** Скрипты, в чьём коде стоит адрес модели из реестра D2, — путь от scripts/. */
function directCallers(): string[] {
  return scriptFiles()
    .filter((f) => {
      const src = readFileSync(f, 'utf-8');
      // Дешёвый отбор по сырому тексту, приговор — по разбору.
      return LLM_HOSTS.some((h) => src.includes(h)) && codeFacts(src, f).hosts.length > 0;
    })
    .map((f) => relative(SCRIPTS_DIR, f));
}

function writesUsageItself(rel: string): boolean {
  const facts = codeFacts(readFileSync(join(SCRIPTS_DIR, rel), 'utf-8'), rel);
  return facts.importsUsageSink && facts.callsSendUsage;
}

describe('скрипт, зовущий модель своим fetch, пишет расход сам', () => {
  it('такие скрипты есть, и разбор их видит', () => {
    // Ноль найденных — сломался поиск (переименовали реестр, сменили хосты), а не «все чисты».
    expect(directCallers()).toContain('editor-runner.ts');
    expect(directCallers()).toContain('unique-routes-scraper.js');
  });

  it('строка с «/*» не прячет вызов модели, а адрес в комментарии вызовом не считается', () => {
    const hidden = [
      "const headers = { Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' };",
      "await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });",
      'try { run(); } catch { /* ignore */ }',
    ].join('\n');
    expect(codeFacts(hidden, 'scraper.js').hosts).toEqual(['api.anthropic.com']);
    const base = 'const base = `https://openrouter.ai/api/v1`;\nawait fetch(`${base}/chat/completions`);';
    expect(codeFacts(base, 'runner.ts').hosts).toEqual(['openrouter.ai']);
    const onlyComments = "// fetch('https://api.anthropic.com/v1/messages')\n/* openrouter.ai — по гео */\nexport {};";
    expect(codeFacts(onlyComments, 'note.ts').hosts).toEqual([]);
    // Слова в комментарии — не отправка расхода.
    expect(codeFacts("// sendUsageToProd(rows)\nimport { x } from '../lib/ai/usage-sink';", 'r.ts'))
      .toMatchObject({ importsUsageSink: true, callsSendUsage: false });
  });

  it('каждый пишет расход в книги или назван с причиной', () => {
    const bad = directCallers().filter((f) => !Object.prototype.hasOwnProperty.call(DIRECT_CALLERS_OUTSIDE_BOOKS, f) && !writesUsageItself(f));
    expect(bad, `модель зовут мимо книг: ${bad.join(', ')} — usage-sink или запись с причиной`).toEqual([]);
  });

  it('шаг, который запускает пишущего, несёт CRON_SECRET из секретов', () => {
    const writers = directCallers().filter((f) => !Object.prototype.hasOwnProperty.call(DIRECT_CALLERS_OUTSIDE_BOOKS, f));
    expect(writers.length).toBeGreaterThan(0);
    for (const f of writers) {
      const steps = stepsRunning([f]);
      expect(steps.length, `${f} не запускается ни одним workflow`).toBeGreaterThan(0);
      for (const st of steps) {
        expect(String(st.env.CRON_SECRET ?? ''), `${st.file} → ${st.step}: без секрета расход в книги не попадёт`).toMatch(/secrets\.CRON_SECRET/);
      }
    }
  });

  it('артефакт ложится вне рабочей копии: шаг с секретом исполняет код из checkout, а не из артефакта', () => {
    // Ревью безопасности #3149: os-audit распаковывал артефакт произвольного
    // прогона поверх checkout, а следующий шаг запускал scripts/ с секретами.
    type DlStep = { name?: string; uses?: string; with?: Record<string, unknown> };
    const downloads: Array<{ file: string; step: string; path: unknown }> = [];
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
      const doc = load(readFileSync(join(WORKFLOWS, file), 'utf-8')) as { jobs?: Record<string, { steps?: DlStep[] }> } | null;
      for (const job of Object.values(doc?.jobs ?? {})) {
        for (const st of job.steps ?? []) {
          if (!String(st.uses ?? '').startsWith('actions/download-artifact')) continue;
          downloads.push({ file, step: st.name ?? '(без имени)', path: st.with?.path });
        }
      }
    }
    // Ноль найденных — сломался разбор, а не «скачиваний нет».
    expect(downloads.length).toBeGreaterThan(0);
    for (const d of downloads) {
      expect(String(d.path ?? ''), `${d.file} → ${d.step}: артефакт распаковывается в рабочую копию`)
        .toMatch(/^\$\{\{\s*runner\.temp\s*\}\}\//);
    }
  });

  it('список «мимо книг» только сокращается', () => {
    const callers = new Set(directCallers());
    for (const [f, why] of Object.entries(DIRECT_CALLERS_OUTSIDE_BOOKS)) {
      expect(why.length, f).toBeGreaterThan(20);
      expect(callers.has(f), `${f} больше не зовёт модель напрямую — уберите запись`).toBe(true);
      expect(writesUsageItself(f), `${f} уже пишет расход сам — уберите запись`).toBe(false);
    }
  });

  // Исполнением: настоящий скрипт под node, fetch подменён до его старта.
  const ROUTE_ROW = {
    id: '11111111-1111-1111-1111-111111111111', title: 'Вулкан Горелый', description: null, category: null,
    kind: 'place', lat: 52.5, lng: 158.0, location_type: 'volcano', activity_type: null, zone: null,
    source_name: null, altitude_m: 1829, terrain_type: null, hazard_types: null, difficulty_level: null,
    nearest_medical_km: null, distance_km: null, elevation_gain_m: null, duration_hours: null, season: null,
    route_type: null, hazards: null, equipment: null, park_name: null,
  };
  const PRELOAD = `
import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://openrouter.ai/')) {
    return new Response(JSON.stringify({
      model: 'anthropic/claude-opus-5-answered',
      choices: [{ message: { content: 'Горелый — действующий вулкан высотой 1829 метров в южной части полуострова.' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u === 'https://vedarai.ru/api/admin/llm-usage/report') {
    writeFileSync(process.env.USAGE_CAPTURE, JSON.stringify({ auth: init.headers.Authorization, body: JSON.parse(init.body) }));
    const status = Number(process.env.USAGE_REPORT_STATUS);
    return new Response(JSON.stringify(status === 200 ? { success: true, written: 1 } : { error: 'сбой' }), { status });
  }
  throw new Error('неожиданный адрес ' + u);
};
`;
  // Асинхронно: прогон скрипта не держит поток воркера, пока node собирает TS.
  async function runEditorRunner(reportStatus: number) {
    const dir = mkdtempSync(join(tmpdir(), 'editor-runner-usage-'));
    try {
      const preload = join(dir, 'preload.mjs');
      const job = join(dir, 'job.json');
      const out = join(dir, 'out.json');
      const capture = join(dir, 'capture.json');
      writeFileSync(preload, PRELOAD);
      writeFileSync(job, JSON.stringify({ queue_total: 1, routes: [ROUTE_ROW] }));
      const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, 'scripts/editor-runner.ts', job, out], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
          OPENROUTER_API_KEY: 'test-key', CRON_SECRET: 'test-secret',
          USAGE_CAPTURE: capture, USAGE_REPORT_STATUS: String(reportStatus),
        },
      });
      let output = '';
      child.stdout.on('data', (d) => { output += String(d); });
      child.stderr.on('data', (d) => { output += String(d); });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      });
      return {
        status,
        output,
        capture: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf-8')) : null,
        result: existsSync(out) ? JSON.parse(readFileSync(out, 'utf-8')) : null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('Editor на раннере отправляет расход: модель ответа, вход без кэша, подпись editor-runner', async () => {
    const r = await runEditorRunner(200);
    expect(r.status, r.output).toBe(0);
    expect(r.capture?.auth).toBe('Bearer test-secret');
    expect(r.capture?.body.rows).toEqual([{
      model: 'anthropic/claude-opus-5-answered', prompt_tokens: 1000, completion_tokens: 300,
      cache_read_tokens: 200, agent_id: 'editor-runner',
    }]);
    expect(r.result?.usage).toEqual({ rows: 1, missing: 0, reported: true });
    expect(r.result?.written).toBe(1);
  }, 90_000);

  it('прод не принял расход — описания всё равно уходят, а отказ назван', async () => {
    const r = await runEditorRunner(500);
    expect(r.status, r.output).toBe(0);
    expect(r.result?.usage).toEqual({ rows: 1, missing: 0, reported: false });
    expect(r.result?.written).toBe(1);
    expect(r.output).toContain('прод НЕ принял');
  }, 90_000);
});

describe('строка книг из ответа OpenAI-совместимого API', () => {
  it('модель — из ответа, вход без кэша, кэш отдельно', () => {
    const row = usageRowFromResponse(
      { model: 'deepseek-v4-pro', usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 300 } } },
      'deepseek-chat', 'editor-runner',
    );
    expect(row).toEqual({ model: 'deepseek-v4-pro', prompt_tokens: 700, completion_tokens: 200, cache_read_tokens: 300, agent_id: 'editor-runner' });
  });

  it('модель не названа — запрошенная; кэш не сообщён — null, а не ноль', () => {
    expect(usageRowFromResponse({ usage: { prompt_tokens: 50, completion_tokens: 10 } }, 'z-ai/glm-5.3', 'a'))
      .toEqual({ model: 'z-ai/glm-5.3', prompt_tokens: 50, completion_tokens: 10, cache_read_tokens: null, agent_id: 'a' });
  });

  it('нет usage или он неполон — null, а не строка с нулями', () => {
    expect(usageRowFromResponse({ choices: [] }, 'm', 'a')).toBeNull();
    expect(usageRowFromResponse({ usage: { prompt_tokens: 5 } }, 'm', 'a')).toBeNull();
    expect(usageRowFromResponse(null, 'm', 'a')).toBeNull();
    expect(usageRowFromResponse('oops', 'm', 'a')).toBeNull();
  });
});

describe('строка книг из usage Anthropic', () => {
  it('ключ anthropic:<модель>, вход без кэша, запись и чтение кэша своими полями', () => {
    expect(usageRowFromAnthropic(
      { input_tokens: 820_000, output_tokens: 41_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 5_000 },
      'claude-fable-5-1', 'os-audit',
    )).toEqual({
      model: 'anthropic:claude-fable-5-1', prompt_tokens: 820_000, completion_tokens: 41_000,
      cache_read_tokens: 30_000, cache_creation_tokens: 5_000, agent_id: 'os-audit',
    });
    // Ноль кэша — сообщённый ноль, а не «не сообщено».
    expect(usageRowFromAnthropic({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, 'm', 'a'))
      .toMatchObject({ cache_read_tokens: 0 });
  });

  it('кэш не сообщён — null, а не ноль; нет входа или выхода — строки нет', () => {
    expect(usageRowFromAnthropic({ input_tokens: 12, output_tokens: 3, cache_read_input_tokens: null }, 'claude-opus-5-5', 'a'))
      .toMatchObject({ cache_read_tokens: null, cache_creation_tokens: null });
    expect(usageRowFromAnthropic({ output_tokens: 3 }, 'm', 'a')).toBeNull();
    expect(usageRowFromAnthropic({ input_tokens: -1, output_tokens: 3 }, 'm', 'a')).toBeNull();
    expect(usageRowFromAnthropic(null, 'm', 'a')).toBeNull();
  });

  it('цена ищется тем же правилом, что у прямого пути решателя', () => {
    expect(priceLookupIds('anthropic:claude-fable-5-1')).toContain('anthropic/claude-fable-5.1');
  });
});

describe('строка одного ответа уходит сразу', () => {
  const realFetch = globalThis.fetch;
  const realSecret = process.env.CRON_SECRET;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = realSecret;
    vi.restoreAllMocks();
  });

  it('ответ без usage — «расход неизвестен» вслух, на прод ничего не уходит', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await reportUsageNow(null, 'проход')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain('расход неизвестен');
  });

  it('строка есть — одна строка на прод с секретом', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const row = { model: 'm', prompt_tokens: 5, completion_tokens: 1, agent_id: 'os-audit' };
    expect(await reportUsageNow(row, 'проход')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://vedarai.ru/api/admin/llm-usage/report');
    expect(JSON.parse(String(init.body))).toEqual({ rows: [row] });
  });
});

// Исполнением: разовые прогоны по маркеру пишут расход сразу после ответа —
// и тогда, когда дальше прогон падает (пустой ответ, ничего не подтвердилось).
// Провальный прогон стоит тех же денег, а process.exit отложенную строку теряет.
const MARKER_PRELOAD = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const ROUTES = JSON.parse(process.env.FAKE_ROUTES);
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === 'https://vedarai.ru/api/admin/llm-usage/report') {
    const cap = process.env.USAGE_CAPTURE;
    const prev = existsSync(cap) ? JSON.parse(readFileSync(cap, 'utf-8')) : [];
    prev.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
    writeFileSync(cap, JSON.stringify(prev));
    return new Response(JSON.stringify({ ok: true, written: 1 }), { status: 200 });
  }
  for (const [prefix, body] of ROUTES) {
    if (u.startsWith(prefix)) {
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  throw new Error('неожиданный адрес ' + u);
};
`;

async function runMarkerScript(
  script: string, args: (dir: string) => string[], routes: Array<[string, unknown]>,
  env: (dir: string) => Record<string, string>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'marker-usage-'));
  try {
    const preload = join(dir, 'preload.mjs');
    const capture = join(dir, 'capture.json');
    writeFileSync(preload, MARKER_PRELOAD);
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, script, ...args(dir)], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        CRON_SECRET: 'test-secret', USAGE_CAPTURE: capture, FAKE_ROUTES: JSON.stringify(routes),
        ...env(dir),
      },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    const reports = existsSync(capture)
      ? (JSON.parse(readFileSync(capture, 'utf-8')) as Array<{ auth: string; body: { rows: unknown[] } }>)
      : [];
    return { status, output, reports };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('разовые прогоны по маркеру пишут расход сразу после ответа', () => {
  it('разбор маршрутов: пустой ответ — прогон красный, расход в книгах', async () => {
    const r = await runMarkerScript(
      'scripts/route-analysis-runner.ts',
      (dir) => {
        const corpus = join(dir, 'corpus.json');
        writeFileSync(corpus, JSON.stringify({ routes: [{ id: 'r1', title: 'Тест', description_head: null, description_len: 0 }] }));
        return [corpus, 'openai/gpt-test'];
      },
      [['https://openrouter.ai/', {
        model: 'openai/gpt-test-answered', choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 90_000, completion_tokens: 0 },
      }]],
      () => ({ OPENROUTER_API_KEY: 'test-key' }),
    );
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('Ответ без содержимого');
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0].auth).toBe('Bearer test-secret');
    expect(r.reports[0].body.rows).toEqual([{
      model: 'openai/gpt-test-answered', prompt_tokens: 90_000, completion_tokens: 0,
      cache_read_tokens: null, agent_id: 'route-analysis',
    }]);
  }, 90_000);

  it('аудит, проверка сохранённых находок: опровергнуто — прогон красный, расход проверки в книгах', async () => {
    const r = await runMarkerScript(
      'scripts/os-audit-runner.ts',
      () => ['openai/gpt-test'],
      [['https://openrouter.ai/', {
        model: 'openai/gpt-test', choices: [{ message: { content: '{"verdict":"refuted","why":"примета не найдена"}' } }],
        usage: { prompt_tokens: 30_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 10_000 } },
      }]],
      (dir) => {
        const findings = join(dir, 'findings.json');
        writeFileSync(findings, JSON.stringify({
          commit: null, invented: 0, unquoted: 0,
          good: [{ kind: 'defect', severity: 'low', files: ['CLAUDE.md'], what: 'Тест', evidence: '«Тест»', proposal: '' }],
        }));
        return { OPENROUTER_API_KEY: 'test-key', AUDIT_FINDINGS_IN: findings };
      },
    );
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('Ни одной ПОДТВЕРЖДЁННОЙ');
    expect(r.reports.map((x) => x.body.rows)).toEqual([[{
      model: 'openai/gpt-test', prompt_tokens: 20_000, completion_tokens: 50,
      cache_read_tokens: 10_000, agent_id: 'os-audit',
    }]]);
  }, 90_000);

  it('подбор источников через DeepSeek: пустой ответ — отказ назван, оплаченный расход в книгах', async () => {
    const r = await runMarkerScript(
      'scripts/source-discovery-runner.ts',
      () => ['deepseek'],
      [
        ['https://api.deepseek.com/models', { data: [{ id: 'deepseek-v4-pro' }] }],
        ['https://api.deepseek.com/v1/chat/completions', {
          model: 'deepseek-v4-pro', choices: [{ message: { content: '' } }],
          usage: {
            prompt_tokens: 3_000, completion_tokens: 8_000, prompt_cache_hit_tokens: 1_000, prompt_cache_miss_tokens: 2_000,
            completion_tokens_details: { reasoning_tokens: 8_000 },
          },
        }],
      ],
      () => ({ DEEPSEEK_API_KEY: 'test-key' }),
    );
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain('пустой ответ');
    expect(r.reports.map((x) => x.body.rows)).toEqual([[{
      model: 'deepseek-v4-pro', prompt_tokens: 2_000, completion_tokens: 8_000,
      cache_read_tokens: 1_000, agent_id: 'source-discovery',
    }]]);
  }, 90_000);
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
    // 600, а не 400: с 06.11 перед запросом стоит строка прямого DeepSeek
    // (цена его страницы, без каталога) — порядок проверяется тот же.
    const head = PROVIDERS.slice(at, at + 600);
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

interface Reduction { step: WfStep; upload: WfStep }

/**
 * Выжимка расхода в работе руки: первая загрузка артефакта после руки и
 * последний шаг с `run` перед ней. Что шаг пишет именно загружаемый файл,
 * проверяется исполнением (`runReduction`), а не по тексту.
 */
function reductionOf(h: Hand): Reduction | null {
  const after = (h.job.steps ?? []).slice(h.stepIndex + 1);
  const uploadAt = after.findIndex((s) => (s.uses ?? '').startsWith('actions/upload-artifact@'));
  if (uploadAt < 0) return null;
  const step = after.slice(0, uploadAt).reverse().find((s) => typeof s.run === 'string');
  return step ? { step, upload: after[uploadAt] } : null;
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

    it(`${h.file}: к учёту уезжает выжимка, а не файл выполнения, — при ЛЮБОМ исходе руки`, () => {
      const r = reductionOf(h);
      expect(r, 'после руки нет пары «выжимка — загрузка»').not.toBeNull();
      const { step: reduce, upload } = r as Reduction;
      // Упавший или оборванный прогон тоже тратил — без always() его расход
      // не доехал бы до книг ровно тогда, когда он самый непредсказуемый.
      expect(reduce.if ?? '').toMatch(/always\(\)/);
      expect(upload.if ?? '').toMatch(/always\(\)/);
      // Выжимка берёт файл, названный самим экшеном.
      expect(String(reduce.env?.HAND_EXECUTION_FILE)).toBe(`\${{ steps.${id}.outputs.execution_file }}`);
      // Запрет: сырой файл выполнения — транскрипт агента со всеми выводами
      // инструментов — в артефакт публичного репозитория не идёт (ревью
      // AC-1). Что в артефакте именно выжимка — ниже, исполнением шага.
      expect(String(upload.with?.path ?? '')).not.toMatch(/execution_file|claude-execution-output/);
      const books = booksJob(h);
      const download = (books?.job.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/download-artifact@'));
      expect(download?.with?.name, 'учёт скачивает не тот артефакт').toBe(upload.with?.name);
      // Учёт читает то, что скачал: файл с именем выжимки.
      expect(basename(String(books?.step.env?.EXECUTION_FILE ?? ''))).toBe(basename(String(upload.with?.path ?? '')));
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

// ── Выжимка в работе руки — исполнением шага workflow ───────────────────
//
// Ревью AC-1: файл выполнения — полный транскрипт агента (выводы Bash и Read,
// тексты чужих issues, логи CI), а артефакт публичного репозитория скачивает
// любой пользователь GitHub без маски секретов. Шаг выжимки исполняется
// настоящим bash и jq на транскрипте с подложенным секретом.

const PLANTED = 'ghs_PLANTEDsecretFROMtoolOUTPUT0123456789';
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const ALLOWED_KEYS = new Set([
  'type', 'total_cost_usd', 'modelUsage',
  'inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens',
  'message', 'id', 'model', 'usage',
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
]);

/** Транскрипт образца, в который секрет попал везде, куда его может занести агент. */
function leakyTranscript(): Array<Record<string, unknown>> {
  const msgs = (fixtureMessages() as Array<Record<string, unknown>>).map((m) => structuredClone(m));
  for (const m of msgs) {
    m.leak = PLANTED;
    const msg = m.message as Record<string, unknown> | undefined;
    if (msg && typeof msg === 'object') {
      msg.content = [
        { type: 'text', text: `env: CRON_SECRET=${PLANTED}` },
        { type: 'tool_use', id: 'toolu_leak', name: 'Bash', input: { command: `echo ${PLANTED}` } },
      ];
      msg.stop_sequence = PLANTED;
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') usage.service_tier = PLANTED;
    }
    if (m.type === 'result') {
      m.result = `Готово. Токен: ${PLANTED}`;
      m.permission_denials = [{ tool_name: 'Bash', tool_input: { command: PLANTED } }];
      for (const u of Object.values(m.modelUsage as Record<string, Record<string, unknown>>)) u.note = PLANTED;
    }
  }
  msgs.splice(1, 0, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_leak', content: `${PLANTED}\n` }] },
  });
  return msgs;
}

/** Что в выжимке не из белого списка: ключи, строки, логические. */
function violations(v: unknown, path = '$', parentKey = ''): string[] {
  if (v === null || typeof v === 'number') return [];
  if (typeof v === 'string') {
    if (parentKey === 'type' && (v === 'result' || v === 'assistant')) return [];
    if ((parentKey === 'id' || parentKey === 'model') && IDENT.test(v)) return [];
    return [`${path}: строка «${v.slice(0, 60)}»`];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => violations(x, `${path}[${i}]`));
  if (typeof v !== 'object') return [`${path}: ${typeof v}`];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    // Ключи modelUsage — имена моделей; пустое — метка «имя не прошло».
    const modelKey = parentKey === 'modelUsage';
    if (modelKey ? !(k === '' || IDENT.test(k)) : !ALLOWED_KEYS.has(k)) out.push(`${path}: ключ «${k.slice(0, 60)}»`);
    out.push(...violations(x, `${path}.${k}`, modelKey ? '#model' : k));
  }
  return out;
}

/** Исполняет шаг выжимки так, как его исполнит раннер: bash -e, только env. */
function runReduction(r: Reduction, runnerTemp: string, handExecutionFile: string) {
  const res = spawnSync('bash', ['-e', '-c', r.step.run ?? ''], {
    env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: runnerTemp, HAND_EXECUTION_FILE: handExecutionFile },
    encoding: 'utf-8',
  });
  // Путь загрузки — со стороны workflow; шаг обязан писать именно его.
  const uploaded = String(r.upload.with?.path ?? '').replace('${{ runner.temp }}', runnerTemp);
  return {
    status: res.status,
    log: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    uploaded,
    reduced: existsSync(uploaded) ? (JSON.parse(readFileSync(uploaded, 'utf-8')) as unknown) : undefined,
  };
}

describe('выжимка в работе руки — одни счётчики', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hands-reduce-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  for (const h of hands()) {
    const reduction = (): Reduction => {
      const r = reductionOf(h);
      if (!r) throw new Error(`${h.file}: после руки нет пары «выжимка — загрузка»`);
      // Шаг исполняется как написан: выражения workflow в тексте скрипта
      // подставились бы до bash — данные ему идут только через env.
      expect(r.step.run ?? '').not.toContain('${{');
      return r;
    };
    const write = (name: string, body: unknown): string => {
      const p = join(dir, name);
      writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
      return p;
    };

    it(`${h.file}: в артефакт не попадает ни текст, ни tool_use, ни секрет — а разбор тот же`, async () => {
      const leaky = leakyTranscript();
      const src = write('claude-execution-output.json', leaky);
      const res = runReduction(reduction(), dir, src);
      expect(res.status, res.log).toBe(0);
      expect(res.reduced, `${res.uploaded} не создан`).toBeDefined();
      const text = JSON.stringify(res.reduced);
      expect(text).not.toContain(PLANTED);
      expect(text).not.toMatch(/"(content|text|tool_use|tool_result|result|leak|permission_denials|session_id)"\s*:/);
      expect(violations(res.reduced)).toEqual([]);
      // Выжимка — без потерь для учёта: разбор и отправка те же, что по сырому.
      const parsed = parseExecution(res.reduced);
      expect(parsed.form).toBe('result');
      expect(parsed).toEqual(parseExecution(leaky));
      const bodies: string[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ written: 2, unknown_cost: 0, cost_usd_known: 0.4 }), { status: 200 });
      }) as unknown as typeof fetch;
      const env = { AGENT_ID: 'claude', CRON_SECRET: 's', HAND_EXECUTION_FILE: src };
      await runHandsUsage({ env: { ...env, EXECUTION_FILE: res.uploaded }, fetchImpl });
      await runHandsUsage({ env: { ...env, EXECUTION_FILE: src }, fetchImpl });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    });

    it(`${h.file}: обрыв без итога — ответы модели с id, по-прежнему без текста`, () => {
      const cut = leakyTranscript().filter((m) => m.type !== 'result');
      const res = runReduction(reduction(), dir, write('cut.json', cut));
      expect(res.status, res.log).toBe(0);
      expect(JSON.stringify(res.reduced)).not.toContain(PLANTED);
      expect(violations(res.reduced)).toEqual([]);
      const parsed = parseExecution(res.reduced);
      expect(parsed.form).toBe('assistant');
      expect(parsed).toEqual(parseExecution(cut));
    });

    it(`${h.file}: текст на месте имени или числа — null, и расход «не разобран», а не утёк`, () => {
      const odd = [
        {
          type: 'result',
          total_cost_usd: `${PLANTED}`,
          modelUsage: { [`Bearer ${PLANTED} leaked`]: { inputTokens: 1, outputTokens: PLANTED } },
        },
        { type: 'assistant', message: { id: `id ${PLANTED}`, model: `m ${PLANTED}`, usage: { input_tokens: PLANTED } } },
      ];
      const res = runReduction(reduction(), dir, write('odd.json', odd));
      expect(res.status, res.log).toBe(0);
      expect(JSON.stringify(res.reduced)).not.toContain(PLANTED);
      expect(violations(res.reduced)).toEqual([]);
      const parsed = parseExecution(res.reduced);
      expect(parsed.form).toBe('unknown');
      expect(parsed.rows).toEqual([]);
    });

    it(`${h.file}: файл не JSON — метка «не прочёл», учёт называет расход неразобранным`, async () => {
      const res = runReduction(reduction(), dir, write('broken.json', `{"result": "${PLANTED}"`));
      expect(res.status, res.log).toBe(0);
      expect(res.reduced).toEqual({ hands_usage: 'unreadable' });
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const run = await runHandsUsage({
        env: { AGENT_ID: 'claude', CRON_SECRET: 's', EXECUTION_FILE: res.uploaded, HAND_EXECUTION_FILE: '/x.json' },
        fetchImpl,
      });
      expect(run.exitCode).toBe(0);
      expect(run.out.join('\n')).toMatch(/::warning::.*не разобран.*jq/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it(`${h.file}: экшен не назвал файл — берётся путь по умолчанию; нет и его — выжимки нет`, () => {
      const none = runReduction(reduction(), dir, '');
      expect(none.status, none.log).toBe(0);
      // Выжимки нет — решать, потеря это или «рука не дошла до модели», будет
      // учёт по HAND_EXECUTION_FILE, а не этот шаг.
      expect(none.reduced).toBeUndefined();
      write('claude-execution-output.json', fixtureMessages());
      const fallback = runReduction(reduction(), dir, '');
      expect(fallback.status, fallback.log).toBe(0);
      expect(parseExecution(fallback.reduced)).toEqual(parseExecution(fixtureMessages()));
    });
  }
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

  it('чтение кэша у вендора, чьих множителей мы не знаем, — оценка сверху с пометкой, а не вход без кэша', async () => {
    // Чтение кэша не дороже входа: прочитанное по полной цене входа — граница
    // сверху, видимая дневному бюджету (ревью 29.10). Прежде здесь была NULL.
    const res = await post([{ model: 'othervendor:some-model', prompt_tokens: 1000, completion_tokens: 200, cache_read_tokens: 5000 }]);
    expect(res.status).toBe(200);
    const [[, params]] = inserts() as Array<[string, unknown[]]>;
    expect(params[4] as number).toBeCloseTo(((1000 + 5000) * IN_PRICE + 200 * OUT_PRICE) / 1e6, 10);
    expect(params[5]).toBe('model_catalog_cache_upper_bound');
    const body = await res.json() as { unknown_cost: number };
    expect(body.unknown_cost).toBe(0);
  });

  it('запись в кэш у вендора, чьих множителей мы не знаем, — цена неизвестна: граница есть только у чтения', async () => {
    const res = await post([{ model: 'othervendor:some-model', prompt_tokens: 1000, completion_tokens: 200, cache_creation_tokens: 5000 }]);
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
