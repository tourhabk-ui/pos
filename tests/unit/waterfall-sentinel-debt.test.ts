/**
 * Заглушка водопада не должна доезжать до разбора.
 *
 * Экран владельца 04.09: панель агентов показала у Scout-Innovator диагноз
 * «в ответе нет JSON-массива (len=55, head="Извините, сервис временно
 * недоступен. Попробуйте позже.")». По букве верно, по сути ложь: массива нет
 * не потому, что модель ответила плохо, а потому, что не ответил НИКТО. В
 * разбор уехала строка-извинение, которую callAIWaterfall возвращает вместо
 * ответа, и диагноз назвал следствие вместо причины — на панели это выглядит
 * как капризная модель при мёртвых провайдерах.
 *
 * Строку callAIWaterfall отдавать обязан: её показывают человеку в чате, где
 * пустота хуже извинения. Но всякий, кто ответ РАЗБИРАЕТ, а не показывает,
 * обязан либо звать callAIWaterfallOrNull, либо сверяться с
 * isWaterfallErrorResponse.
 *
 * Список ниже — замороженный долг: файлы, которые зовут callAIWaterfall и
 * заглушку не проверяют. Он может только СОКРАЩАТЬСЯ. Новый такой файл
 * краснит сборку; починенный убирается из списка тем же коммитом. Тот же
 * приём, что у schema-coverage: долг, который видно, лечится, а долг, о
 * котором молчат, растёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isWaterfallErrorResponse, AI_FAST_UNAVAILABLE } from '@/lib/ai/providers';
import { parseProposalsResponse } from '@/lib/agents/scout-innovator';

const ROOT = process.cwd();

/** Замороженный долг на 04.09. Только сокращать. */
const UNCHECKED_CALLERS: readonly string[] = [
  'app/api/agents/rescue-briefing/route.ts',
  'app/api/agents/rescue-consult/route.ts',
  'app/api/ai/judge-rag/route.ts',
  'app/api/ai/route.ts',
  'app/api/operator/tours/auto-fill-ai/route.ts',
  'app/api/telegram/admin/route.ts',
  'app/api/telegram/kuzmich/route.ts',
  'app/api/tools/equipment/route.ts',
  'lib/agents/execution/handlers/code-change-executor.ts',
  'lib/agents/kuzmich-place-enricher.ts',
  'lib/import/passport-enrich-runner.ts',
  'lib/import/route-endpoints-runner.ts',
  'lib/kuzmich/operator-chat.ts',
  'lib/services/ingest/legislation-importer.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

function uncheckedCallers(): string[] {
  const found: string[] = [];
  for (const dir of ['lib', 'app']) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (rel === 'lib/ai/providers.ts') continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (!/\bcallAIWaterfall\(/.test(code)) continue;
      if (code.includes('isWaterfallErrorResponse')) continue;
      found.push(rel);
    }
  }
  return found.sort();
}

describe('долг: кто разбирает ответ водопада, не проверив заглушку', () => {
  it('новых должников нет — список только сокращается', () => {
    const current = uncheckedCallers();
    const added = current.filter((f) => !UNCHECKED_CALLERS.includes(f));
    expect(added, `Новый разбор ответа callAIWaterfall без проверки заглушки: ${added.join(', ')}. `
      + 'Зови callAIWaterfallOrNull (отказ придёт null) либо сверяйся с isWaterfallErrorResponse.').toEqual([]);
  });

  it('починенное вычёркивается тем же коммитом, а не копится в списке', () => {
    const current = uncheckedCallers();
    const stale = UNCHECKED_CALLERS.filter((f) => !current.includes(f));
    expect(stale, `Эти файлы уже проверяют заглушку — убери их из UNCHECKED_CALLERS: ${stale.join(', ')}`).toEqual([]);
  });

  it('агенты, чья диагностика идёт в панель, долг не несут', () => {
    const current = uncheckedCallers();
    for (const f of ['lib/agents/scout-innovator.ts', 'lib/agents/memory-reflector.ts', 'lib/agents/memory-contradiction.ts']) {
      expect(current, `${f} снова разбирает заглушку как ответ модели`).not.toContain(f);
    }
  });
});

describe('Scout-Innovator называет причину, а не следствие', () => {
  it('заглушка водопада — «не ответил ни один провайдер», а не «нет JSON-массива»', () => {
    const r = parseProposalsResponse('Извините, сервис временно недоступен. Попробуйте позже.');
    expect(r.proposals).toEqual([]);
    expect(r.diag).toMatch(/не ответил ни один провайдер/);
    expect(r.diag).not.toMatch(/нет JSON-массива/);
    // Вторая заглушка того же семейства — из callAIFast.
    expect(isWaterfallErrorResponse(AI_FAST_UNAVAILABLE)).toBe(true);
    expect(parseProposalsResponse(AI_FAST_UNAVAILABLE).diag).toMatch(/не ответил ни один провайдер/);
  });

  it('настоящий мусор от модели по-прежнему называется мусором', () => {
    expect(parseProposalsResponse('Вот мои мысли без JSON').diag).toMatch(/нет JSON-массива/);
    expect(parseProposalsResponse('[]').diag).toMatch(/осознанно вернула пустой массив/);
  });

  it('в прогоне отказ водопада не путается с ответом модели', () => {
    const src = readFileSync(join(ROOT, 'lib/agents/scout-innovator.ts'), 'utf-8');
    expect(src).toMatch(/await callAIWaterfallOrNull\(messages\)/);
    expect(src).toMatch(/не ответил ни один провайдер \(\$\{why\}\)/);
    expect(src).toMatch(/describeRecentAiFailures\(\)/);
  });
});
