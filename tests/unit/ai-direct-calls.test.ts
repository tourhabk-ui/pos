// @vitest-environment node
/**
 * Модель зовут через водопад, а не по имени провайдера (#2451).
 *
 * Правило CLAUDE.md §4: callDeepSeek и callOpenrouter напрямую — только в
 * lib/ai/providers.ts и в пробах провайдеров; всем остальным — callAIWaterfall
 * или callAIFast. Водопад переживает отказ ноги и пишет расход в книги;
 * прямой вызов не делает ни того, ни другого: умер провайдер — молчит экран.
 *
 * До 14.10 правило держал только хук .husky/pre-commit. В CI хук не
 * выполняется, обходится --no-verify, в облачных сессиях не установлен вовсе,
 * а видел он одну форму — `await callDeepSeek`; `probe(() => callOpenrouter(…))`
 * проходил мимо. Scout-Innovator 13.10 предложил завести такой хук, не зная,
 * что он есть: дыра была не в отсутствии хука, а в том, что запрет держался
 * только там.
 *
 * Упоминание ищется деревом TypeScript: комментарий, строка и регулярка — не
 * вызов. Поиск по тексту поймал бы промпт агента («прямой callDeepSeek вместо
 * callAIWaterfall») и сканер ПД со списком имён — они нарушителями не были.
 *
 * Предел назван вслух. Имена — те, что называет правило. Прочие ноги
 * (callQwen, callXai, callAnthropic, зрение, разбор PDF и речи) правило не
 * называет, и прямой вызов там бывает решением владельца: первая фаза
 * scout-innovator зовёт callQwen (24.09). Расширять список — отдельная
 * перепись по каждому месту, а не заморозка вслепую. callMiMo в списке нет:
 * функцию удалила перепись блока D (census-block-d), звать нечего.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const PROVIDERS = 'lib/ai/providers.ts';

/** Функции, которые правило запрещает звать мимо водопада. */
const DIRECT: readonly string[] = ['callDeepSeek', 'callOpenrouter'];

/**
 * Пробы: спросить КАЖДОГО провайдера по имени — их смысл. Водопад подменил бы
 * мёртвого живым, и проба ответила бы «отвечает». Запись самоустаревает:
 * файл перестал звать провайдера напрямую — тест требует убрать её.
 */
const PROBES: Readonly<Record<string, string>> = {
  'app/api/admin/ai-check/route.ts':
    'диагностика админа: кто из провайдеров отвечает и с каким ключом',
  'app/api/cron/health/route.ts':
    'крон здоровья: проба каждого провайдера по отдельности, тревога в Telegram',
  'app/api/cron/model-knowledge-probe/route.ts':
    'проба «знает ли модель о нас»: вопрос задаётся конкретной модели, подмена другой обесценила бы ответ',
  'app/api/telegram/admin/route.ts':
    'команда статуса в админ-боте: какие ноги Кузьмича отвечают с прода',
};

/** Каталоги корня, где нет кода приложения. */
const SKIP_AT_ROOT = new Set(['_archive', 'coverage', 'docs', 'migrations', 'public', 'test', 'tests']);
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (dir === ROOT && SKIP_AT_ROOT.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_FILE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Строки, где функция провайдера названа в коде: вызов, импорт, передача значением. */
function directMentions(fileName: string, src: string): number[] {
  if (!DIRECT.some((name) => src.includes(name))) return [];
  const file = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const lines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && DIRECT.includes(node.text)) {
      lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return [...lines].sort((a, b) => a - b);
}

function mentionsByFile(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const full of walk(ROOT)) {
    const rel = relative(ROOT, full).split('\\').join('/');
    const lines = directMentions(rel, readFileSync(full, 'utf-8'));
    if (lines.length > 0) found.set(rel, lines);
  }
  return found;
}

function exportedNames(fileName: string): Set<string> {
  const file = ts.createSourceFile(fileName, readFileSync(join(ROOT, fileName), 'utf-8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names = new Set<string>();
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) names.add(node.name.text);
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
  });
  return names;
}

describe('кто зовёт провайдера по имени (#2451)', () => {
  const found = mentionsByFile();

  it('вне providers.ts и проб — никто', () => {
    const outside = [...found]
      .filter(([file]) => file !== PROVIDERS && !(file in PROBES))
      .map(([file, lines]) => `${file}:${lines.join(',')}`);
    expect(outside, `Прямой вызов провайдера мимо водопада: ${outside.join('; ')}. `
      + 'Зови callAIWaterfall() или callAIFast(). Если это проба провайдера — внеси файл в PROBES с причиной.').toEqual([]);
  });

  it('проба из списка существует, названа причиной и всё ещё зовёт провайдера напрямую', () => {
    for (const [file, reason] of Object.entries(PROBES)) {
      expect(existsSync(join(ROOT, file)), `${file} из PROBES не существует`).toBe(true);
      expect(reason.trim().length, `у ${file} в PROBES нет причины`).toBeGreaterThan(20);
      expect(found.has(file), `${file} больше не зовёт провайдера напрямую — убери запись из PROBES`).toBe(true);
    }
  });

  it('каждое имя из списка providers.ts действительно объявляет', () => {
    // Иначе сторож молча стерёг бы имя, которое позвать нельзя, — так было
    // бы с callMiMo после её удаления.
    const exported = exportedNames(PROVIDERS);
    for (const name of DIRECT) {
      expect(exported.has(name), `${name} больше не экспортируется из ${PROVIDERS} — сторож стережёт пустое имя`).toBe(true);
    }
  });
});

describe('детектор: вызов — да, слово в тексте — нет', () => {
  const at = (src: string, fileName = 'lib/x.ts'): number[] => directMentions(fileName, src);

  it('вызов в любой форме, импорт и передача значением — упоминание', () => {
    expect(at('const a = await callDeepSeek(m);')).toEqual([1]);
    // Без await: этой формы хук не видел.
    expect(at('probe(() => callOpenrouter(PING));')).toEqual([1]);
    expect(at("import { callDeepSeek } from '@/lib/ai/providers';")).toEqual([1]);
    expect(at('probeAI(callDeepSeek);')).toEqual([1]);
    expect(at('await providers.callOpenrouter(m);')).toEqual([1]);
    expect(at("const { callDeepSeek: ds } = await import('@/lib/ai/providers');")).toEqual([1]);
    expect(at('<button onClick={() => callDeepSeek(m)} />', 'components/X.tsx')).toEqual([1]);
    expect(at('a();\n\nawait callDeepSeek(m);\nawait callOpenrouter(m);')).toEqual([3, 4]);
  });

  it('комментарий, строка, шаблон, регулярка и чужое имя — не упоминание', () => {
    expect(at('// await callDeepSeek(m)')).toEqual([]);
    expect(at('/** не зови callOpenrouter(m) напрямую */')).toEqual([]);
    // Сканер ПД держит имена строками.
    expect(at("const LLM_CALLS = ['callDeepSeek', 'callOpenrouter'];")).toEqual([]);
    // Промпт агента называет правило словами.
    expect(at('const rules = `прямой callDeepSeek вместо callAIWaterfall`;')).toEqual([]);
    // finding-guard узнаёт находку регуляркой.
    expect(at('const aiProvider = /callDeepSeek|callOpenrouter/i;')).toEqual([]);
    expect(at('await callDeepSeekWithTools(m, tools);')).toEqual([]);
    expect(at('await callAIWaterfall(m);')).toEqual([]);
  });
});
