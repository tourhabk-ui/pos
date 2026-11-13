/**
 * Сторож: разбор за сутки — кто на какой модели.
 *
 * Слово владельца 13.11 («2 и 3 да делай») по руководству Anthropic для
 * Fable 5.2: субагенты могут составлять большую часть цены сессии, и надо
 * знать, на какой модели они идут. В скриптах скилла `day-review` модель не
 * задавалась вовсе — значит все агенты разбора шли на модели сессии.
 *
 * Теперь чтение PR приколото к Sonnet, а всё, где решают или судят
 * безопасность, остаётся на модели сессии (CLAUDE.md §5.1). Сторож держит
 * обе половины: экономию (читатель без модели наследует флагман молча) и
 * границу (тревога дайджеста на дешёвой модели — не экономия).
 *
 * Скрипты исполняются с подставленными `agent`, `parallel`, `pipeline`:
 * судится, с какой моделью агент был вызван на деле, а не текст скрипта.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPTS = join(ROOT, '.claude/skills/day-review/scripts');

interface AgentCall {
  prompt: string;
  label?: string;
  phase?: string;
  model?: string;
}

interface Group {
  key: string;
  title: string;
  prs: string;
  careful?: boolean;
}

/** Ответ подставного агента — по форме, которую ждёт следующий шаг скрипта. */
function stubAnswer(label: string | undefined): unknown {
  if (label?.startsWith('поиск:')) {
    return {
      tests_run: '',
      good: '',
      findings: [{ pr: 1, title: 'находка', file: 'lib/x.ts', line: 1, severity: 'minor', lens: 'ошибка', scenario: 's', fix_idea: 'i' }],
    };
  }
  if (label?.startsWith('опровержение:')) {
    return { verdicts: [{ index: 0, real: true, severity: 'minor', reason: 'путь реален' }] };
  }
  return {};
}

interface Run {
  calls: AgentCall[];
  meta: { phases: Array<{ title: string; model?: string }> };
  result: unknown;
  logs: string[];
}

/**
 * Исполнить скрипт Workflow с подставным окружением и вернуть вызовы агентов.
 * `fail` — агенты, которые не отвечают: `null` (пропуск, отказ модели после
 * повторов) или `throw` (ошибка вызова, например неизвестное имя модели).
 */
async function runScript(file: string, args: unknown, fail: Record<string, 'null' | 'throw'> = {}): Promise<Run> {
  const calls: AgentCall[] = [];
  const logs: string[] = [];
  const src = readFileSync(join(SCRIPTS, file), 'utf8');
  expect(src, `${file}: нет export const meta`).toMatch(/^export const meta = /m);
  const body = `${src.replace(/^export const meta = /m, 'const meta = ')}\n`;

  const agent = async (prompt: string, opts: Omit<AgentCall, 'prompt'> = {}) => {
    calls.push({ prompt, label: opts.label, phase: opts.phase, model: opts.model });
    const how = fail[opts.label ?? ''];
    if (how === 'throw') throw new Error('модель не принята');
    if (how === 'null') return null;
    return stubAnswer(opts.label);
  };
  const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()));
  const pipeline = (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>) =>
    Promise.all(items.map(async (item, i) => {
      let prev: unknown = item;
      for (const stage of stages) prev = await stage(prev, item, i);
      return prev;
    }));

  // meta возвращается отдельным вызовом: в самом скрипте return занят итогом.
  const metaOf = new Function(`${body.split('\n\n')[0]}\nreturn meta;`) as () => { phases: Array<{ title: string; model?: string }> };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', body);
  const result = await run(args, agent, parallel, pipeline, () => undefined, (m: unknown) => { logs.push(String(m)); });
  return { calls, meta: metaOf(), result, logs };
}

const WINDOW = { from: '2026-11-12T00:00:00Z', to: '2026-11-13T00:00:00Z' };

function progressArgs(groups: Group[], over: Partial<{ digestIssues: number[]; otherIssues: number[] }> = {}) {
  return {
    window: WINDOW,
    groups,
    openPrs: [{ pr: 3300, branch: 'wip-x' }],
    digestIssues: over.digestIssues ?? [3302],
    otherIssues: over.otherIssues ?? [3315],
  };
}

const byLabel = (calls: AgentCall[], label: string) => {
  const hit = calls.filter((c) => c.label === label);
  expect(hit, `агент «${label}» вызван не один раз`).toHaveLength(1);
  return hit[0];
};

describe('разбор прогресса: чтение PR — на Sonnet', () => {
  it('тема без пометки и открытые PR читаются на Sonnet', async () => {
    const { calls } = await runScript('progress.workflow.js', progressArgs([
      { key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' },
      { key: 'site', title: 'Сайт и аналитика', prs: '#2 bbb' },
    ]));
    // Без явной модели агент наследует модель сессии — экономия исчезает молча.
    expect(byLabel(calls, 'тема:prokat').model).toBe('sonnet');
    expect(byLabel(calls, 'тема:site').model).toBe('sonnet');
    expect(byLabel(calls, 'открытые PR').model).toBe('sonnet');
  });

  it('тревоги дайджеста, предложения и проверка полноты — на модели сессии', async () => {
    const { calls } = await runScript('progress.workflow.js', progressArgs([
      { key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' },
    ]));
    // Тревога дайджеста — безопасность туриста; посылку предложения и главные
    // утверждения читателей проверяет тот, кто отвечает за отчёт.
    expect(byLabel(calls, 'тревоги дайджеста').model).toBeUndefined();
    expect(byLabel(calls, 'предложения').model).toBeUndefined();
    expect(byLabel(calls, 'полнота').model).toBeUndefined();
  });

  it('тема с пометкой careful читается моделью сессии', async () => {
    const { calls } = await runScript('progress.workflow.js', progressArgs([
      { key: 'kuzmich', title: 'Кузьмич и чат оператора', prs: '#1 aaa', careful: true },
      { key: 'site', title: 'Сайт и аналитика', prs: '#2 bbb' },
    ]));
    expect(byLabel(calls, 'тема:kuzmich').model).toBeUndefined();
    expect(byLabel(calls, 'тема:site').model).toBe('sonnet');
  });

  it('тема про безопасность, деньги или ПД — на модели сессии и без пометки', async () => {
    // По одному названию на каждое слово правила: выпавшее слово краснеет поимённо.
    const careful = [
      'SOS через соседа',
      'Номер 112 в ответах',
      'Безопасность мест',
      'Тревоги ленты',
      'Регистрация в МЧС',
      'Оплата брони',
      'Платёж СБП',
      'Платежи операторов',
      'Деньги оператора',
      'Комиссия платформы',
      'Возврат туристу',
      'Выплата оператору',
      'Персональные данные гостя',
      'Согласие на ПД',
      'ПД: согласия в формах',
      'Контроль выхода',
    ];
    // «Апдейт» содержит «пд» внутри слова — это не тема про персональные данные.
    const plain = ['Прокат машин', 'Подбор туров', 'Сайт и аналитика', 'Жильё в MAX', 'Подписи фото', 'Апдейт карточки тура'];
    const groups: Group[] = [...careful, ...plain].map((title, i) => ({ key: `g${i}`, title, prs: '#1 aaa' }));
    const { calls } = await runScript('progress.workflow.js', progressArgs(groups));
    careful.forEach((title, i) => {
      expect(byLabel(calls, `тема:g${i}`).model, `«${title}» ушла дешёвой модели`).toBeUndefined();
    });
    plain.forEach((title, i) => {
      // Слово в названии только поднимает модель; обычную тему оно не трогает.
      expect(byLabel(calls, `тема:g${careful.length + i}`).model, `«${title}» читается моделью сессии`).toBe('sonnet');
    });
  });

  it('проверяющий полноту знает, что читала модель дешевле, и перепроверяет больше трёх утверждений', async () => {
    const { calls } = await runScript('progress.workflow.js', progressArgs([
      { key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' },
    ]));
    const critic = byLabel(calls, 'полнота').prompt;
    expect(critic).toContain('модель дешевле твоей');
    expect(critic).toMatch(/перепроверь по коду 5 самых важных/);
  });

  it('без тревог и предложений их агентов нет, читатели остаются на Sonnet', async () => {
    const { calls } = await runScript('progress.workflow.js', progressArgs(
      [{ key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' }],
      { digestIssues: [], otherIssues: [] },
    ));
    expect(calls.map((c) => c.label).sort()).toEqual(['открытые PR', 'полнота', 'тема:prokat']);
    expect(byLabel(calls, 'тема:prokat').model).toBe('sonnet');
  });

  it('у каждого агента фаза из объявленных, и модель фазы совпадает с моделью агента', async () => {
    const { calls, meta } = await runScript('progress.workflow.js', progressArgs([
      { key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' },
      { key: 'pay', title: 'Оплата брони', prs: '#2 bbb' },
    ]));
    const phaseModel = new Map(meta.phases.map((p) => [p.title, p.model]));
    for (const c of calls) {
      expect(phaseModel.has(c.phase ?? ''), `«${c.label}»: фаза «${c.phase}» не объявлена в meta`).toBe(true);
      // Экран прогона показывает модель фазы: она не должна расходиться с делом.
      expect(c.model, `«${c.label}»: модель агента и модель фазы «${c.phase}» расходятся`).toBe(phaseModel.get(c.phase ?? ''));
    }
  });
});

describe('разбор прогресса: агент без ответа назван, а не пуст', () => {
  const groups: Group[] = [
    { key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' },
    { key: 'site', title: 'Сайт и аналитика', prs: '#2 bbb' },
  ];
  const shape = (r: unknown) => r as { groups: unknown[]; open_prs: unknown; digest: unknown; proposals: unknown; critic: unknown; unanswered: string[] };

  it('все ответили — список пуст', async () => {
    const { result, logs } = await runScript('progress.workflow.js', progressArgs(groups));
    expect(shape(result).unanswered).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('читатель вернул пусто — он в unanswered и в логе, место темы в итоге не сдвинулось', async () => {
    const { result, logs } = await runScript('progress.workflow.js', progressArgs(groups), { 'тема:prokat': 'null' });
    const r = shape(result);
    expect(r.unanswered).toEqual(['тема:prokat']);
    expect(logs.join('\n')).toContain('«тема:prokat» не вернул ответа');
    // Тема без ответа — null на своём месте: вторая тема не выдаётся за первую.
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]).toBeNull();
    expect(r.groups[1]).not.toBeNull();
    expect(r.open_prs).not.toBeNull();
  });

  it('вызов агента упал (например, имя модели не принято) — тот же исход, прогон не рвётся', async () => {
    const { result, calls } = await runScript('progress.workflow.js', progressArgs(groups), {
      'тема:site': 'throw',
      'открытые PR': 'throw',
    });
    const r = shape(result);
    expect([...r.unanswered].sort()).toEqual(['открытые PR', 'тема:site']);
    expect(r.groups[1]).toBeNull();
    expect(r.open_prs).toBeNull();
    // Остальные агенты отработали, проверка полноты состоялась.
    expect(r.groups[0]).not.toBeNull();
    expect(byLabel(calls, 'полнота')).toBeTruthy();
  });

  it('проверяющему полноту названо, кто не ответил', async () => {
    const { calls } = await runScript('progress.workflow.js', progressArgs(groups), { 'тема:prokat': 'null' });
    const critic = byLabel(calls, 'полнота').prompt;
    expect(critic).toContain('Не вернули ответа: тема:prokat');
    const { calls: clean } = await runScript('progress.workflow.js', progressArgs(groups));
    expect(byLabel(clean, 'полнота').prompt).not.toContain('Не вернули ответа');
  });

  it('проверяющий полноту не ответил — это тоже названо', async () => {
    const { result } = await runScript('progress.workflow.js', progressArgs(groups), { полнота: 'throw' });
    const r = shape(result);
    expect(r.unanswered).toEqual(['полнота']);
    expect(r.critic).toBeNull();
  });

  it('справка по запуску говорит, что делать с unanswered', () => {
    const doc = readFileSync(join(ROOT, '.claude/skills/day-review/references/workflow-args.md'), 'utf8');
    expect(doc).toContain('Сначала прочитай `unanswered`');
  });
});

describe('разбор качества: искатель и опровергатель — на модели сессии', () => {
  it('ни одному агенту дешёвая модель не задана', async () => {
    const { calls } = await runScript('quality.workflow.js', {
      window: WINDOW,
      scratch: '/tmp/x',
      groups: [{ key: 'prokat', title: 'Прокат машин', prs: '#1 aaa' }],
    });
    // Искатель судит ПД, 112 и деньги, опровергатель выносит решение (§5.1).
    expect(calls.map((c) => c.label)).toEqual(['поиск:prokat', 'опровержение:prokat']);
    for (const c of calls) expect(c.model, `«${c.label}» ушёл на другую модель`).toBeUndefined();
  });
});

describe('правило, которое это объявляет', () => {
  const CLAUDE_MD = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const SKILL = readFileSync(join(ROOT, '.claude/skills/day-review/SKILL.md'), 'utf8');
  const ARGS_DOC = readFileSync(join(ROOT, '.claude/skills/day-review/references/workflow-args.md'), 'utf8');

  it('CLAUDE.md §5.1 называет разбор за сутки и ведёт к этому сторожу', () => {
    // Только §5.1: в §5.2 скилл и сторож названы по другому поводу.
    const at = CLAUDE_MD.indexOf('Рутина сессии — на Sonnet');
    const end = CLAUDE_MD.indexOf('\n### 5.2 ');
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const block = CLAUDE_MD.slice(at, end);
    expect(block).toContain('(`day-review`)');
    expect(block).toContain('tests/unit/day-review-models.test.ts');
  });

  it('шаг «Отчёт владельцу» ссылается на §5.2, и такой раздел есть', () => {
    // Стиль отчёта сторож не судит; он держит связку: потребитель правила
    // ссылается на раздел, и раздел с этим номером и именем существует.
    expect(SKILL).toContain('CLAUDE.md §5.2 «Как писать владельцу»');
    expect(CLAUDE_MD).toMatch(/^### 5\.2 Как писать владельцу/m);
  });

  it('скилл и справка по запуску говорят про пометку careful', () => {
    // Пометку ставит тот, кто заполняет группы: без слова о ней в справке
    // тема про безопасность уйдёт читателю на Sonnet по умолчанию.
    expect(SKILL).toContain('`careful: true`');
    // И правило словами, и пример вызова: пример копируют чаще, чем читают правило.
    expect(ARGS_DOC).toContain('- `careful: true` у группы');
    expect(ARGS_DOC).toMatch(/prs: '[^']+', careful: true \}/);
  });
});
