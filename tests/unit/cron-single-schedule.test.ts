/**
 * Один эндпоинт под /api/cron/ — одно расписание GitHub Actions.
 *
 * Обобщение `rescue-single-schedule.test.ts` (#1725): Rescue до 08.09 шёл
 * двумя расписаниями, и одно из двух описаний его запуска было неверным
 * всегда. Аудит 15.10 (P2-18) нашёл ту же болезнь ещё у двоих:
 * `telegram-webhook-watchdog` и `llm-budget-check` звал и свой workflow, и
 * третьим шагом `cron-watchdog.yml` — шагом, который не читал HTTP-код
 * (`curl` без `-f` и `|| true`): его отказ не красил ничего. Аренда окна
 * гасила повторную работу, но не ложь о том, кто крон запускает.
 *
 * Что считается: scheduled-workflow (есть `schedule:` с `cron:`), который
 * зовёт адрес — в самом yml вне строк-комментариев, либо через скрипт из
 * `scripts/`, запущенный этим workflow (то же второе звено, что у
 * `cron-scheduler-declared`), — и несёт CRON_SECRET. Без секрета прод отвечает
 * 401 и работы не начинает: так стучится проба периметра
 * (`perimeter-smoke.yml`), и это не расписание крона, а проверка замка.
 * Вторая нога в `start.js` сюда не входит намеренно:
 * это не второе расписание GitHub, а запасной планировщик с арендой окна, и
 * его держит свой сторож — `cron-second-leg.test.ts`.
 *
 * Исключения — самоустаревающий список с причиной и ТОЧНЫМ составом файлов:
 * исчез дубль — запись обязана уйти; появился новый файл с тем же адресом —
 * красный, даже если адрес в списке.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF_DIR = join(ROOT, '.github', 'workflows');

/** Строки, которые не вызов: комментарии yml и шапки скриптов. */
function codeLines(src: string): string {
  return src.split('\n').filter((line) => {
    const t = line.trimStart();
    return !(t.startsWith('#') || t.startsWith('//') || t.startsWith('*'));
  }).join('\n');
}

function isScheduled(src: string): boolean {
  return /^\s*schedule:\s*$/m.test(src) && /^\s*-\s*cron:\s*['"]/m.test(src);
}

/** Вызовы /api/cron/<ep> с query-строкой (нужна исключению kuzmich). */
function cronCalls(src: string): Array<{ ep: string; query: string }> {
  return [...codeLines(src).matchAll(/\/api\/cron\/([a-z0-9-]+)(\?[^\s"'\\]*)?/g)]
    .map((m) => ({ ep: m[1], query: m[2] ?? '' }));
}

interface Caller { file: string; queries: string[] }

/** Scheduled-workflow с вызовами, но без секрета: стучатся, а не запускают. */
const PROBES_WITHOUT_SECRET: string[] = [];

/** endpoint → какие scheduled-workflow его зовут. */
function scheduledCallers(): Map<string, Caller[]> {
  const out = new Map<string, Caller[]>();
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  for (const file of files) {
    const src = readFileSync(join(WF_DIR, file), 'utf8');
    if (!isScheduled(src)) continue;
    const calls = cronCalls(src);
    let carriesSecret = codeLines(src).includes('CRON_SECRET');
    for (const m of codeLines(src).matchAll(/scripts\/[A-Za-z0-9._/-]+/g)) {
      const p = join(ROOT, m[0]);
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      const script = readFileSync(p, 'utf8');
      calls.push(...cronCalls(script));
      if (codeLines(script).includes('CRON_SECRET')) carriesSecret = true;
    }
    if (calls.length > 0 && !carriesSecret) {
      PROBES_WITHOUT_SECRET.push(file);
      continue;
    }
    const byEp = new Map<string, string[]>();
    for (const c of calls) byEp.set(c.ep, [...(byEp.get(c.ep) ?? []), c.query]);
    for (const [ep, queries] of byEp) out.set(ep, [...(out.get(ep) ?? []), { file, queries }]);
  }
  return out;
}

/**
 * Эндпоинты, которые законно зовёт больше одного scheduled-workflow.
 * Состав файлов точный: новый файл с тем же адресом — красный.
 */
const SHARED_ON_PURPOSE: Record<string, { files: string[]; why: string }> = {
  kuzmich: {
    files: ['cron-kuzmich-route.yml', 'cron-kuzmich-tip.yml', 'cron-kuzmich-tour.yml'],
    why:
      'одна ручка на три РАЗНЫХ поста канала — маршрут, совет и тур, выбор по ?type=. У каждого ' +
      'поста своё время аудитории и ровно одно расписание; дубля работы нет, это три джобы. ' +
      'Держится проверкой ниже: значения type= у файлов попарно различны',
  },
  health: {
    files: ['cron-health.yml', 'redteam-kuzmich.yml'],
    why:
      'в redteam-kuzmich.yml health — диагностический шаг ежемесячного прогона red-team ' +
      '(причина отказа OpenRouter тем же прогоном, if: always()), а не второе расписание здоровья: ' +
      'один лишний вызов в месяц рядом с прогоном, которому он нужен',
  },
};

const CALLERS = scheduledCallers();

describe('перепись вызовов читается из workflow', () => {
  it('scheduled-workflow с вызовами /api/cron/ найдены', () => {
    // Ноль при нулевом входе — отказ, а не успех (§4.0): сломайся разбор, и
    // все проверки ниже стали бы зелёными на пустоте.
    expect(CALLERS.size).toBeGreaterThan(40);
  });

  it('проба периметра без секрета — не расписание крона', () => {
    // perimeter-smoke стучится в /api/cron/watchdog без секрета и ждёт 401:
    // это проверка замка, работа там не начинается. Других таких нет —
    // появится — пусть это будет видно здесь, а не пройдёт молча.
    expect(PROBES_WITHOUT_SECRET).toEqual(['perimeter-smoke.yml']);
  });

  it('строка-комментарий не считается вызовом', () => {
    // evo-judge.yml называет llm-budget-check в комментарии — это не вызов.
    const budget = CALLERS.get('llm-budget-check')?.map((c) => c.file) ?? [];
    expect(budget).not.toContain('evo-judge.yml');
  });
});

describe('один эндпоинт — одно расписание', () => {
  it('каждый адрес зовёт не больше одного scheduled-workflow, кроме названных с причиной', () => {
    const offenders: string[] = [];
    for (const [ep, callers] of CALLERS) {
      if (callers.length <= 1) continue;
      const files = callers.map((c) => c.file).sort();
      const allowed = SHARED_ON_PURPOSE[ep];
      if (!allowed || JSON.stringify([...allowed.files].sort()) !== JSON.stringify(files)) {
        offenders.push(`${ep}: ${files.join(', ')}`);
      }
    }
    expect(
      offenders,
      'эндпоинт запускается несколькими расписаниями — одно из описаний его запуска неверно ' +
      '(#1725, аудит 15.10 P2-18). Убери дубль или внеси в SHARED_ON_PURPOSE с причиной и точным составом файлов: ' +
      offenders.join(' | '),
    ).toEqual([]);
  });

  it('проверка вебхука Telegram и бюджета AI — по одному расписанию (P2-18)', () => {
    expect(CALLERS.get('telegram-webhook-watchdog')?.map((c) => c.file)).toEqual(['cron-safety-heartbeat.yml']);
    expect(CALLERS.get('llm-budget-check')?.map((c) => c.file)).toEqual(['cron-llm-budget.yml']);
  });

  it('cron-watchdog.yml зовёт только сам Watchdog', () => {
    const own = [...CALLERS].filter(([, cs]) => cs.some((c) => c.file === 'cron-watchdog.yml')).map(([ep]) => ep);
    expect(own).toEqual(['watchdog']);
  });
});

describe('исключения не переживают свою причину', () => {
  for (const [ep, allowed] of Object.entries(SHARED_ON_PURPOSE)) {
    it(`${ep}: дубль ещё есть, и состав файлов тот же`, () => {
      const files = (CALLERS.get(ep) ?? []).map((c) => c.file).sort();
      expect(files.length, `${ep} больше не зовут несколько расписаний — запись устарела, убери её`).toBeGreaterThan(1);
      expect(files).toEqual([...allowed.files].sort());
      expect(allowed.why.length, 'причина не может быть отпиской').toBeGreaterThan(60);
    });
  }

  it('kuzmich: три файла — три разных поста, а не один пост трижды', () => {
    const types = (CALLERS.get('kuzmich') ?? []).map((c) => {
      const t = c.queries.map((q) => /[?&]type=([a-z]+)/.exec(q)?.[1]).filter(Boolean);
      expect(t.length, `${c.file}: вызов без ?type=`).toBe(1);
      return t[0];
    });
    expect(new Set(types).size).toBe(types.length);
  });
});
