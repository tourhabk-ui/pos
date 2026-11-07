/**
 * Вкладка «Деньги» страницы «Расходы AI» (владелец 07.11: «объясни мне где что
 * и как смотреть расходы и за что», затем «наведи порядок в этом разделе»).
 *
 * До этого дня «Расходы AI» показывали счётчик действий и блок «стоимость пока
 * не пишется» — по колонке ai_actions_log.cost_usd, которую не пишет никто.
 * Настоящие книги (llm_usage_log) жили карточкой в «Health-метриках», а «за
 * что» не показывал ни один экран. Здесь — рендером и вызовом:
 *   - сутки против лимита: три исхода переменной и перерасход — словами,
 *     вызовы без цены названы, а не растворены в сумме;
 *   - «за что» по агентам и «по моделям»: «цена не посчитана» — не «$0»;
 *   - остаток на счетах: четыре исхода;
 *   - страница открывается на «Деньгах», счётчик действий — по клику и без денег;
 *   - подписи «за что» — в обе стороны: у каждого, кто подписывает расход, есть
 *     подпись, и у каждой подписи есть такой писатель.
 * Запросы книг исполняются на схеме прода: tests/integration/leads-followup.pg.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import AiMoneyClient, { AiMoneyView, type AiMoney } from '@/app/hub/admin/ai-usage/_AiMoneyClient';
import AdminAiUsagePage from '@/app/hub/admin/ai-usage/page';
import {
  agentSpendLabel, SPEND_LABELS, UNOWNED_SPEND_LABEL, toAgentSpend, toSpendToday,
} from '@/lib/ai/model-spend';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import { spendIdOf } from '@/lib/agents/agents-value-census';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const w = (calls: number, tokens: number, cost: number | null, unknown = 0) =>
  ({ calls, tokens, cost_usd: cost, unknown_cost_calls: unknown });
const NONE = w(0, 0, null);

function money(budget: Partial<AiMoney['budget']> = {}, over: Partial<AiMoney> = {}): AiMoney {
  const base: AiMoney = {
    balances: [
      { id: 'deepseek', label: 'DeepSeek', status: 'ok', amount: 12.5, currency: 'USD', detail: 'баланс из API' },
      { id: 'openrouter', label: 'OpenRouter', status: 'failed', amount: null, currency: null, detail: 'HTTP 503' },
      { id: 'xai', label: 'xAI', status: 'no_key', amount: null, currency: null, detail: 'ключ не задан' },
      { id: 'qwen', label: 'Qwen', status: 'unsupported', amount: null, currency: null, detail: 'остаток в консоли Alibaba' },
      { id: 'anthropic', label: 'Anthropic', status: 'unsupported', amount: null, currency: null, detail: 'остаток в Console' },
    ],
    spend: [
      { model: 'deepseek-v4-pro', provider_guess: 'deepseek', d1: w(4, 12_000, 0.0123), d7: w(30, 90_000, 0.25, 2), d30: w(120, 2_500_000, 1.5, 2) },
      { model: 'probe-model-x', provider_guess: 'unknown', d1: NONE, d7: w(3, 900, null, 3), d30: w(3, 900, null, 3) },
    ],
    by_agent: [
      { agent_id: 'kuzmich', label: 'Кузьмич — живые разговоры', d1: w(4, 12_000, 0.0123), d7: w(30, 90_000, 0.25, 2), d30: w(120, 2_500_000, 1.5, 2) },
      { agent_id: null, label: UNOWNED_SPEND_LABEL, d1: NONE, d7: w(3, 900, null, 3), d30: w(3, 900, null, 3) },
    ],
    budget: {
      limit: { kind: 'unset' },
      today: { since: '2026-11-07T00:00:00.000Z', calls: 12, cost_usd: 0.4321, unpriced_calls: 3 },
    },
    checked_at: '2026-11-07T05:00:00.000Z',
  };
  return { ...base, ...over, budget: { ...base.budget, ...budget } };
}

const today = () => screen.getByRole('region', { name: 'Сегодня' }).textContent ?? '';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Сегодня против дневного лимита', () => {
  it('лимит не задан — сказано, что перерасход никто не сторожит, и где он задаётся', () => {
    render(<AiMoneyView data={money()} />);
    expect(today()).toContain('$0.4321 за сутки');
    expect(today()).toContain('Дневной лимит не задан — перерасход никто не сторожит');
    expect(today()).toContain('AI_DAILY_BUDGET_USD');
    expect(today()).not.toContain('из лимита');
  });

  it('лимит задан и не превышен — сколько из лимита и куда придёт тревога', () => {
    render(<AiMoneyView data={money({ limit: { kind: 'set', usd: 5 } })} />);
    expect(today()).toContain('$0.4321 из лимита $5.00 на сутки');
    expect(today()).toContain('тревога в Telegram');
    expect(today()).not.toContain('превышен');
  });

  it('перерасход назван словами', () => {
    const data = money({
      limit: { kind: 'set', usd: 5 },
      today: { since: '2026-11-07T00:00:00.000Z', calls: 40, cost_usd: 7.5, unpriced_calls: 0 },
    });
    render(<AiMoneyView data={data} />);
    expect(today()).toContain('Лимит превышен: $7.50 при лимите $5.00 на сутки');
  });

  it('переменная задана, но не число — «лимит не работает», а не «лимита нет»', () => {
    render(<AiMoneyView data={money({ limit: { kind: 'invalid' } })} />);
    expect(today()).toContain('AI_DAILY_BUDGET_USD задан, но это не число больше нуля — лимит не работает');
    expect(today()).not.toContain('не задан —');
  });

  it('вызовы без цены названы и в сумму не вошли; без них — ни слова о цене', () => {
    render(<AiMoneyView data={money()} />);
    expect(today()).toContain('12 вызовов модели, из них 3 без цены — в сумму не вошли.');
    cleanup();
    render(<AiMoneyView data={money({ today: { since: '2026-11-07T00:00:00.000Z', calls: 1, cost_usd: 0.01, unpriced_calls: 0 } })} />);
    expect(today()).toContain('1 вызов модели.');
    expect(today()).not.toContain('без цены');
  });

  it('сутки названы по Камчатке — граница та же, что у тревоги о бюджете', () => {
    render(<AiMoneyView data={money()} />);
    // Полночь UTC — полдень на Камчатке (UTC+12).
    expect(today()).toMatch(/Сутки — с 7 ноября\D+12:00 по Камчатке/);
    cleanup();
    render(<AiMoneyView data={money({ today: { since: '', calls: 0, cost_usd: 0, unpriced_calls: 0 } })} />);
    expect(today()).not.toContain('Сутки — с');
  });
});

describe('За что и по моделям', () => {
  it('агенты — подписями, пустое окно — прочерк, «без цены» — словами', () => {
    render(<AiMoneyView data={money()} />);
    const rows = within(screen.getByRole('table', { name: 'Расход по агентам' })).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const kuzmich = rows[1].textContent ?? '';
    expect(kuzmich).toContain('Кузьмич — живые разговоры');
    expect(kuzmich).toContain('$0.0123');
    expect(kuzmich).toContain('$0.2500 +2 без цены');
    expect(kuzmich).toContain('$1.50 +2 без цены');
    expect(kuzmich).toContain('120 выз. · 2.5M');
    const unowned = within(rows[2]).getAllByRole('cell').map((c) => c.textContent);
    expect(unowned[0]).toBe(UNOWNED_SPEND_LABEL);
    expect(unowned[1]).toBe('—');
    expect(unowned[2]).toBe('цена не посчитана');
  });

  it('модель без цены не выдаётся за бесплатную', () => {
    render(<AiMoneyView data={money()} />);
    const rows = within(screen.getByRole('table', { name: 'Расход по моделям' })).getAllByRole('row');
    const unpriced = rows.find((r) => r.textContent?.includes('probe-model-x'));
    expect(unpriced?.textContent).toContain('цена не посчитана');
    expect(unpriced?.textContent).not.toMatch(/\$0(\.0+)?\b/);
    expect(rows.find((r) => r.textContent?.includes('deepseek-v4-pro'))?.textContent).toContain('· deepseek');
  });

  it('пустые книги — сказано, что вызовов не было, а не пустая таблица', () => {
    render(<AiMoneyView data={money({}, { by_agent: [], spend: [] })} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('За 30 дней в журнале нет ни одного вызова модели.')).toBeTruthy();
    expect(screen.getByText('За 30 дней в журнале нет ни одного вызова с токенами.')).toBeTruthy();
  });
});

describe('Остаток на счетах', () => {
  it('четыре исхода — остаток, «не смог спросить», «ключа нет», «API не отдаёт»', () => {
    render(<AiMoneyView data={money()} />);
    const box = screen.getByRole('region', { name: 'Остаток на счетах' });
    const text = box.textContent ?? '';
    expect(text).toContain('DeepSeek: 12.50 USD');
    expect(text).toContain('OpenRouter: не смог спросить');
    expect(text).toContain('xAI: ключа нет');
    const summary = within(box).getByText(/Без API баланса/);
    expect(summary.textContent).toBe('Без API баланса: 2 провайдера — остаток только в их кабинетах');
    expect(text).toContain('Qwen · остаток в консоли Alibaba');
  });

  it('число провайдеров без API — по-русски', () => {
    const one = money();
    one.balances = one.balances.filter((b) => b.id !== 'anthropic');
    render(<AiMoneyView data={one} />);
    expect(screen.getByText(/Без API баланса/).textContent).toBe('Без API баланса: 1 провайдер — остаток только в их кабинетах');
  });

  it('сказано, чего здесь не видно: сессии Claude Code', () => {
    render(<AiMoneyView data={money()} />);
    expect(screen.getByText(/сессии разработки в Claude Code — их счёт в вашем кабинете Anthropic/)).toBeTruthy();
  });
});

describe('Загрузка вкладки', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('ответ пришёл — вкладка нарисована по нему', async () => {
    const fetchMock = respond(200, { success: true, data: money() });
    vi.stubGlobal('fetch', fetchMock);
    render(<AiMoneyClient />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Сегодня' })).toBeTruthy());
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/admin/health/ai-money']);
  });

  it('отказ сервера — его слова на экране, а не пустая вкладка', async () => {
    vi.stubGlobal('fetch', respond(500, { success: false, error: 'Ошибка проверки денег' }));
    render(<AiMoneyClient />);
    expect(await screen.findByText('Ошибка проверки денег')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Сегодня' })).toBeNull();
  });

  it('сеть не ответила — так и сказано', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<AiMoneyClient />);
    expect(await screen.findByText('Деньги на ИИ не загрузились: сеть не ответила')).toBeTruthy();
  });
});

describe('Страница «Расходы AI»', () => {
  it('открывается на «Деньгах»; счётчик действий — по клику, без денег, в адресе', async () => {
    window.history.replaceState(null, '', '/hub/admin/ai-usage');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const body = String(url).includes('/api/admin/health/ai-money')
        ? { success: true, data: money() }
        : { success: true, data: { totals: { today: 5, week: 40, month: 100 }, by_action_type: [], by_provider: [], daily: [] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminAiUsagePage />);

    expect(screen.getByRole('tab', { name: 'Деньги' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Сегодня' })).toBeTruthy());
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/admin/health/ai-money']);

    fireEvent.click(screen.getByRole('tab', { name: 'Активность' }));
    expect(await screen.findByText(/Это счётчик, а не деньги/)).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/admin/analytics/ai-usage'));
    expect(window.location.search).toBe('?tab=activity');
    expect(document.body.textContent).not.toMatch(/Стоимость|стоимость пока не пишется/);

    fireEvent.click(screen.getByRole('tab', { name: 'Деньги' }));
    expect(window.location.search).toBe('');
  });
});

describe('Строки книг — в ответ экрану', () => {
  it('агент: токены из текста, цена из numeric, NULL-агент — «без подписи»', () => {
    const row = {
      agent_id: null,
      calls_1: 2, tokens_1: '30', cost_1: '0.5', unknown_1: 1,
      calls_7: 3, tokens_7: '45', cost_7: '1.5', unknown_7: 1,
      calls_30: 4, tokens_30: '3000000000', cost_30: null, unknown_30: 4,
    };
    const a = toAgentSpend(row);
    expect(a.label).toBe(UNOWNED_SPEND_LABEL);
    expect(a.d1).toEqual({ calls: 2, tokens: 30, cost_usd: 0.5, unknown_cost_calls: 1 });
    // Больше 2^31: `::int` в запросе упал бы, текст — нет.
    expect(a.d30).toEqual({ calls: 4, tokens: 3_000_000_000, cost_usd: null, unknown_cost_calls: 4 });
  });

  it('сегодня: начало суток — ISO, не прочлось — пусто, а не «сейчас»', () => {
    expect(toSpendToday({ since: new Date('2026-11-07T00:00:00Z'), calls: 3, spent: '0.25', unpriced: 1 }))
      .toEqual({ since: '2026-11-07T00:00:00.000Z', calls: 3, cost_usd: 0.25, unpriced_calls: 1 });
    expect(toSpendToday(undefined)).toEqual({ since: '', calls: 0, cost_usd: 0, unpriced_calls: 0 });
  });
});

// ── Подписи «за что»: связка в обе стороны ──────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

// Код судится ДЕРЕВОМ РАЗБОРА, а не текстом с вырезанными регэкспом
// комментариями (ревью безопасности #3144): строка вроде 'text/html,*/*'
// открывала «комментарий» до ближайшего */ и прятала за ним вызовы.
function parse(file: string, src: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
}

/** Все строковые литералы файла — то, что код на самом деле содержит. */
function literalsOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Строковые константы верхнего уровня: `const NAME = 'value'`, с export или без. */
function stringConsts(sf: ts.SourceFile): Map<string, { value: string; exported: boolean }> {
  const out = new Map<string, { value: string; exported: boolean }>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const exported = (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) {
        out.set(d.name.text, { value: d.initializer.text, exported });
      }
    }
  }
  return out;
}

/**
 * Кто подписывает расход в книгах llm_usage_log: «руки» — переменной AGENT_ID
 * шага учёта в workflow; код — первым аргументом runWithUsageTracking,
 * fallbackAgentId у провайдеров, полем agent_id у строк для usage-sink и
 * последним аргументом usageRowFromResponse (скрипт раннера со своим fetch).
 * logAgentRun сюда не относится: это журнал прогонов, расход он не подписывает.
 */
function spendWriters(): Map<string, string> {
  const found = new Map<string, string>();
  const wfDir = join(ROOT, '.github/workflows');
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const m of read(`.github/workflows/${f}`).matchAll(/^\s*AGENT_ID:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/gm)) {
      found.set(m[1], `.github/workflows/${f}`);
    }
  }

  const files = ['app', 'lib', 'scripts'].flatMap((d) => walk(join(ROOT, d)));
  const raw = new Map(files.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]));
  const parsed = new Map<string, ts.SourceFile>();
  const sfOf = (file: string): ts.SourceFile => {
    let sf = parsed.get(file);
    if (!sf) { sf = parse(file, raw.get(file) ?? ''); parsed.set(file, sf); }
    return sf;
  };
  const resolve = (file: string, name: string): string => {
    const own = stringConsts(sfOf(file)).get(name);
    if (own) return own.value;
    const values = new Set<string>();
    for (const [other, text] of raw) {
      if (!text.includes(`export const ${name}`)) continue;
      const c = stringConsts(sfOf(other)).get(name);
      if (c?.exported) values.add(c.value);
    }
    if (values.size !== 1) throw new Error(`${file}: константа ${name} не разрешилась (${values.size} значений)`);
    return [...values][0];
  };
  /** Подпись из выражения: литерал или КОНСТАНТА; переменная — null. */
  const idOf = (file: string, e: ts.Expression | undefined): string | null => {
    if (!e) return null;
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isIdentifier(e) && /^[A-Z][A-Z0-9_]*$/.test(e.text)) return resolve(file, e.text);
    return null;
  };
  // runWithUsageTracking с переменной: id выбирает сам файл. Новый такой вызов —
  // сюда, с его id; каждый id обязан стоять в файле литералом.
  const VARIABLE_CALLERS: Record<string, string[]> = {
    'app/api/cron/kuzmich-eval/route.ts': ['kuzmich-eval', 'kuzmich-eval-live', 'kuzmich-eval-commercial'],
  };
  const variableSeen = new Set<string>();
  const TRIGGERS = ['runWithUsageTracking', 'fallbackAgentId', 'usageRowFromResponse', 'usage-sink'];

  for (const [file, text] of raw) {
    // Дешёвый отбор по сырому тексту, приговор — по разбору.
    if (!TRIGGERS.some((t) => text.includes(t))) continue;
    let importsSink = false;
    const sinkRows: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /(^|\/)lib\/ai\/usage-sink$/.test(n.moduleSpecifier.text)) {
        importsSink = true;
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        if (n.expression.text === 'runWithUsageTracking') {
          const id = idOf(file, n.arguments[0]);
          if (id !== null) found.set(id, file);
          else {
            expect(VARIABLE_CALLERS[file], `${file}: runWithUsageTracking с переменной — впишите её id в VARIABLE_CALLERS`).toBeDefined();
            variableSeen.add(file);
          }
        }
        if (n.expression.text === 'usageRowFromResponse') {
          const id = idOf(file, n.arguments[2]);
          expect(id, `${file}: usageRowFromResponse — подпись переменной, сторож её не видит`).not.toBeNull();
          if (id !== null) found.set(id, file);
        }
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
        if (n.name.text === 'fallbackAgentId') {
          const id = idOf(file, n.initializer);
          if (id !== null) found.set(id, file);
        }
        if (n.name.text === 'agent_id') sinkRows.push(n.initializer);
      }
      ts.forEachChild(n, visit);
    };
    visit(sfOf(file));
    // agent_id строк для usage-sink: импорт и по алиасу, и относительный ('../lib/…').
    if (importsSink) {
      for (const e of sinkRows) {
        const id = idOf(file, e);
        if (id !== null) found.set(id, file);
      }
    }
  }
  for (const [file, ids] of Object.entries(VARIABLE_CALLERS)) {
    expect(variableSeen.has(file), `${file} больше не зовёт runWithUsageTracking с переменной — уберите запись`).toBe(true);
    const literals = literalsOf(sfOf(file));
    for (const id of ids) {
      expect(literals, `${file}: id «${id}» в коде файла не стоит`).toContain(id);
      found.set(id, file);
    }
  }
  return found;
}

describe('Подписи «за что»', () => {
  it('без агента, Кузьмич, реестр кронов и незнакомый id', () => {
    expect(agentSpendLabel(null)).toBe(UNOWNED_SPEND_LABEL);
    expect(agentSpendLabel('kuzmich')).toBe('Кузьмич — живые разговоры');
    const fromRegistry = CRON_REGISTRY.find((e) => !Object.prototype.hasOwnProperty.call(SPEND_LABELS, spendIdOf(e)));
    expect(fromRegistry).toBeDefined();
    if (fromRegistry) expect(agentSpendLabel(spendIdOf(fromRegistry))).toBe(fromRegistry.label);
    // Незнакомому имя не выдумывается: показан сам id.
    expect(agentSpendLabel('probe-no-such-agent')).toBe('probe-no-such-agent');
    // Унаследованные ключи объекта — не подписи: строка из книг остаётся строкой.
    expect(agentSpendLabel('constructor')).toBe('constructor');
    expect(agentSpendLabel('toString')).toBe('toString');
  });

  it('у каждого, кто подписывает расход, подпись есть; у каждой подписи есть писатель', () => {
    const writers = spendWriters();
    // Ноль найденных — отказ поиска, а не «все подписаны» (§4.0).
    expect(writers.size).toBeGreaterThanOrEqual(15);
    for (const [id, where] of writers) {
      expect(agentSpendLabel(id), `${id} (${where}) пишет расход без подписи — добавьте в SPEND_LABELS`).not.toBe(id);
    }
    for (const id of Object.keys(SPEND_LABELS)) {
      expect(writers.has(id), `подпись «${id}» есть, а расход под этим id никто не пишет`).toBe(true);
    }
  });
});

describe('Деньги — в одном месте', () => {
  it('«Health-метрики» не читают деньги второй раз: две карточки одних книг разошлись бы', () => {
    const file = 'app/hub/admin/health/_HealthDashboardClient.tsx';
    const literals = literalsOf(parse(file, read(file)));
    expect(literals.some((l) => l.includes('/api/admin/health/ai-money'))).toBe(false);
  });
});
