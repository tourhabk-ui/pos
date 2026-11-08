/**
 * Сторож: крон, умеющий звать модель, подписывает свой расход.
 *
 * ── Что было (перепись нагрузки Кузьмича, prod-check 166, 08.11) ──────────
 *
 * За 30 дней 16 604 вызова модели легли в книги llm_usage_log без agent_id —
 * строкой «без подписи» на вкладке «Деньги», 14 701 из них — DeepSeek V4 Pro.
 * Кто их делал, книги не знали. Из 49 кронов, которым перепись возможностей
 * (lib/agents/cron-capability-registry) приписывает 'ai', подписывали расход
 * шесть.
 *
 * ── Правило ────────────────────────────────────────────────────────────────
 *
 * Крон с возможностью 'ai' подписывает расход в своём роуте: withSpendAgent
 * или runWithUsageTracking. Подпись — ключ его записи в реестре кронов
 * (spendIdOf: agentId записи, иначе её ключ), чтобы перепись агентов сводила
 * книги с реестром. Крон вне реестра подписывается своим id, и у id есть
 * подпись «за что» (сторож ai-money-tab). withSpendAgent первым делом в
 * обработчике подписывает всё, что обработчик делает, — и вызовы в фоне.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { spendIdOf } from '@/lib/agents/agents-value-census';
import { agentSpendLabel } from '@/lib/ai/model-spend';
import { currentAgentId, runWithUsageTracking, withSpendAgent } from '@/lib/ai/usage-context';

const ROOT = process.cwd();

/**
 * Роуты, где подпись стоит не первым делом, а внутри обработчика, — с причиной.
 * Новый такой роут — сюда тем же коммитом.
 */
const INNER_SIGNED: Record<string, string> = {
  kuzmich: 'вид поста (маршрут, совет, тур, партнёр) выбирается внутри обработчика, а в реестре это три записи',
  editor: 'подпись вокруг прогона Editor — с 07.11',
  evo: 'подпись вокруг оркестратора эволюции — с 07.11',
  intelligence: 'подпись вокруг цикла разведки — с 07.11',
  scout: 'подпись вокруг предложений разведчика',
  'kuzmich-eval': 'три набора проверки, id выбирается по набору',
  'kuzmich-redteam': 'подпись вокруг прогона провокаций',
};

/** id, которые файл выбирает переменной: перечислены здесь и обязаны стоять в файле литералом. */
const VARIABLE_IDS: Record<string, string[]> = {
  'kuzmich-eval': ['kuzmich-eval', 'kuzmich-eval-live', 'kuzmich-eval-commercial'],
};

const SIGNERS = new Set(['withSpendAgent', 'runWithUsageTracking']);

function aiCrons(): string[] {
  return Object.entries(CRON_CAPABILITIES)
    .filter(([, caps]) => (caps as readonly string[]).includes('ai'))
    .map(([key]) => key)
    .sort();
}

/** Адреса /api/cron/* записи реестра: явный endpoint или все адреса её workflow — тем же правилом, что cron-registry-honesty. */
function endpointsOf(e: { endpoint?: string; workflow: string }): string[] {
  if (e.endpoint) return [e.endpoint];
  const file = join(ROOT, '.github/workflows', e.workflow);
  if (!existsSync(file)) return [];
  return [...new Set([...readFileSync(file, 'utf8').matchAll(/\/api\/cron\/([a-z0-9-]+)/g)].map((m) => m[1]))];
}

/** Чем роут подписан: id первых аргументов подписывающих вызовов; переменная — null. */
function signatures(key: string): { ids: Array<string | null>; firstStatementSigned: boolean[] } {
  const file = `app/api/cron/${key}/route.ts`;
  const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ids: Array<string | null> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SIGNERS.has(n.expression.text)) {
      const arg = n.arguments[0];
      ids.push(arg && ts.isStringLiteralLike(arg) ? arg.text : null);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // Обработчик подписан целиком, если его первая инструкция — return withSpendAgent(…).
  const firstStatementSigned: boolean[] = [];
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name || !st.body) continue;
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(st.name.text)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const first = st.body.statements[0];
    const call = first && ts.isReturnStatement(first) ? first.expression : undefined;
    firstStatementSigned.push(Boolean(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression)
      && call.expression.text === 'withSpendAgent'));
  }
  return { ids, firstStatementSigned };
}

describe('withSpendAgent подписывает всё, что внутри', () => {
  it('внутри — id крона, снаружи — никакого', async () => {
    expect(currentAgentId()).toBeNull();
    const seen = await withSpendAgent('danger-analysis', async () => currentAgentId());
    expect(seen).toBe('danger-analysis');
    expect(currentAgentId()).toBeNull();
  });

  it('вызов в фоне после ответа подписан тем же id', async () => {
    let background: Promise<string | null> = Promise.resolve(null);
    const answer = await withSpendAgent('health', async () => {
      background = new Promise((resolve) => setTimeout(() => resolve(currentAgentId()), 5));
      return 'ответ';
    });
    expect(answer).toBe('ответ');
    expect(await background).toBe('health');
  });

  it('ближний контекст главнее: явная подпись внутри побеждает', async () => {
    const inner = await withSpendAgent('kuzmich-eval', async () =>
      (await runWithUsageTracking('kuzmich-eval-live', async () => currentAgentId())).result);
    expect(inner).toBe('kuzmich-eval-live');
  });

  it('отказ внутри не глушится', async () => {
    await expect(withSpendAgent('rescue', async () => { throw new Error('сбой'); })).rejects.toThrow('сбой');
  });
});

describe('крон, умеющий звать модель, подписывает расход', () => {
  const crons = aiCrons();

  it('перепись возможностей нашла кроны с моделью', () => {
    // Ноль — сломался разбор реестра, а не «модель никто не зовёт».
    expect(crons.length).toBeGreaterThan(40);
  });

  it('каждый подписан в своём роуте', () => {
    const unsigned = crons.filter((k) => signatures(k).ids.length === 0);
    expect(unsigned, `зовут модель без подписи расхода: ${unsigned.join(', ')} — withSpendAgent('<id>', …) в обработчике`).toEqual([]);
  });

  it('подпись первым делом — у каждого экспортированного обработчика, кроме названных с причиной', () => {
    const partial = crons
      .filter((k) => !Object.prototype.hasOwnProperty.call(INNER_SIGNED, k))
      .filter((k) => {
        const s = signatures(k).firstStatementSigned;
        return s.length === 0 || s.some((ok) => !ok);
      });
    expect(partial, `обработчик подписан не целиком: ${partial.join(', ')}`).toEqual([]);
  });

  it('подпись — ключ записи реестра, когда крон в реестре', () => {
    const mismatched: string[] = [];
    for (const key of crons) {
      const expected = CRON_REGISTRY.filter((e) => endpointsOf(e).includes(key)).map(spendIdOf);
      if (expected.length === 0) continue;
      const ids = signatures(key).ids.filter((x): x is string => x !== null).concat(VARIABLE_IDS[key] ?? []);
      if (!ids.some((id) => expected.includes(id))) {
        mismatched.push(`${key}: подписан ${JSON.stringify(ids)}, реестр ждёт одно из ${JSON.stringify(expected)}`);
      }
    }
    expect(mismatched, `перепись агентов не сведёт книги с реестром: ${mismatched.join('; ')}`).toEqual([]);
  });

  it('переменная подпись — только у названных, и каждый её id стоит в файле литералом', () => {
    for (const key of crons) {
      const variable = signatures(key).ids.some((id) => id === null);
      if (!variable) continue;
      expect(VARIABLE_IDS[key], `${key}: подпись переменной — впишите её id в VARIABLE_IDS`).toBeDefined();
      const src = readFileSync(join(ROOT, `app/api/cron/${key}/route.ts`), 'utf8');
      for (const id of VARIABLE_IDS[key] ?? []) expect(src, `${key}: id «${id}» в файле не стоит`).toContain(`'${id}'`);
    }
  });

  it('у каждой подписи кронов есть слова «за что»', () => {
    const ids = new Set(crons.flatMap((k) => signatures(k).ids.filter((x): x is string => x !== null)));
    const bare = [...ids].filter((id) => agentSpendLabel(id) === id);
    expect(bare, `подписи без слов на вкладке «Деньги»: ${bare.join(', ')} — SPEND_LABELS`).toEqual([]);
  });

  it('список «подписано внутри» только сокращается: запись без нужды — убрать', () => {
    for (const [key, why] of Object.entries(INNER_SIGNED)) {
      expect(why.length, key).toBeGreaterThan(20);
      expect(crons, `${key}: крона с моделью больше нет — уберите запись`).toContain(key);
      const s = signatures(key).firstStatementSigned;
      expect(s.length > 0 && s.every(Boolean), `${key}: подписан первым делом — запись больше не нужна`).toBe(false);
    }
  });
});
