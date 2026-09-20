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
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

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
