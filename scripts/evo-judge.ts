/**
 * scripts/evo-judge.ts
 *
 * Разбор находок эволюции сильной моделью — НА РАННЕРЕ GitHub.
 *
 * ── Зачем именно на раннере ────────────────────────────────────────────────
 *
 * Решатель эволюции переведён на DeepSeek с Qwen на подхвате не потому, что
 * они лучше, а потому что api.anthropic.com закрыт по гео из России, где
 * стоит прод. Наши кроны — это `curl` с раннера в прод, то есть модель зовёт
 * сервер в РФ, и ключ Anthropic в секретах GitHub делу бы не помог.
 *
 * Здесь работа делается ровно наоборот: находки СКАЧИВАЮТСЯ с прода, а модель
 * зовётся с раннера — он вне РФ, гео-блока нет, релей не нужен.
 *
 * ── Чего этот скрипт НЕ делает ─────────────────────────────────────────────
 *
 * Он ничего не чинит и ничего не пишет в базу. Он только судит и объясняет.
 * Финальное решение по находке остаётся за человеком и за Claude Code в репо —
 * это записано в CLAUDE.md и менять здесь нечего.
 *
 * ── Тишина не считается ответом ────────────────────────────────────────────
 *
 * Нет ключа — падаем с внятной ошибкой, а не выдаём пустой разбор. Модель не
 * ответила по находке — она помечается «не разобрана», а не «шум». Пустой
 * результат, выданный за чистый, — дефект, который мы весь день ловим; в
 * инструменте разбора он был бы особенно дорог.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callAIDecisionDetailed } from '@/lib/ai/providers';
import { redactPII } from '@/lib/security/pii-redact';
import type { ChatMessage } from '@/lib/ai/prompts';

interface Finding {
  id: string;
  category: string;
  severity: string;
  file_path: string | null;
  line_number: number | null;
  title: string;
  description: string | null;
  suggestion: string | null;
}

export type Verdict = 'real' | 'fixed' | 'noise' | 'needs_info' | 'unjudged';

export interface Judged {
  finding: Finding;
  verdict: Verdict;
  reason: string;
  /** Какая модель вынесла вердикт — атрибуция, как у находок Growth Scan. */
  model?: string;
}

const VERDICT_RU: Record<Verdict, string> = {
  real: 'по делу',
  fixed: 'уже починено',
  noise: 'шум',
  needs_info: 'мало данных',
  unjudged: 'не разобрана',
};

const SYSTEM = `Ты разбираешь находки автоматического сканера кода туристической платформы.

Твоя задача — отделить настоящие дефекты от шума сканера, а не пересказать находку.

Отвечай РОВНО в таком виде, одной строкой:
ВЕРДИКТ: real|fixed|noise|needs_info
ПРИЧИНА: одно предложение, не длиннее двадцати слов

real — дефект настоящий, его стоит чинить.
fixed — код приложен, и в нём дефекта уже нет: находка устарела.
noise — сканер ошибся: санкционированная конструкция, ложное совпадение, «X вместо X».
needs_info — находка ССЫЛАЕТСЯ НА ФАЙЛ, но приложенного куска не хватает, чтобы решить.

Если код приложен, суди ПО КОДУ, а не по тексту находки: находка старше кода.

Находка БЕЗ файла — не утверждение о коде, а заметка или предложение. Её судят
по тексту: предложение изучить, внедрить, исследовать — это noise. Отсутствие
кода тут НЕ повод для needs_info: кода у неё и не должно быть.

Если к куску приписано, что он обрезан, отсутствие дефекта В КУСКЕ не значит,
что дефекта нет в файле: это needs_info, а не fixed.

Не выдумывай подробностей, которых нет в находке и в коде.`;

/**
 * Кусок кода к находке — из репозитория, распакованного на том же раннере.
 *
 * Без него судья разбирал ТЕКСТ находки, а не код: 19.08 обе «инъекции» в
 * lib/auth/tourist-helpers получили «по делу» через несколько часов после
 * того, как их починили, — параметр уже стоял в запросе. Там же все три
 * «мало данных» оказались просьбами показать файл, лежавший в двух шагах.
 *
 * Путь берётся из находки, то есть из базы, — значит проверяется как чужой:
 * только относительный, без выхода вверх, только известные расширения.
 */
const SNIPPET_RADIUS = 80;
const SNIPPET_MAX = 16000;
const READABLE = /\.(ts|tsx|js|jsx|sql|json|ya?ml|md)$/i;

/**
 * Имена из текста находки — по ним ищется место в файле.
 *
 * Номер строки в находке — от той версии файла, что видел сканер. Файл с тех
 * пор правили, и окно вокруг устаревшего номера попадает мимо: прогон 3 выдал
 * «приложенный код обрывается до getUpcomingTripsWithReminders» — функция была
 * в файле, но за краем окна.
 */
function identifiersFrom(f: Finding): string[] {
  const text = [f.title, f.description, f.suggestion].filter(Boolean).join(' ');
  const found = text.match(/[A-Za-z_$][A-Za-z0-9_$]{5,}/g) ?? [];
  return [...new Set(found)];
}

export function readSnippet(
  filePath: string | null,
  line: number | null,
  identifiers: string[] = [],
  read: (p: string) => string = (p) => readFileSync(join(process.cwd(), p), 'utf-8'),
): string | null {
  if (!filePath) return null;
  const rel = filePath.trim();
  if (!rel || rel.startsWith('/') || rel.includes('..') || !READABLE.test(rel)) return null;

  let text: string;
  try {
    text = read(rel);
  } catch {
    // Файла нет — это ОТВЕТ, а не пустота: находка может указывать на
    // удалённый файл, и судье полезно знать именно это.
    return null;
  }

  const lines = text.split('\n');

  // Целиком, если файл того размера, где резать нечего: полный файл всегда
  // лучше угаданного окна.
  if (text.length <= SNIPPET_MAX) return text;

  // Где резать: сначала по имени из находки, потом по номеру строки.
  let center = 0;
  for (const id of identifiers) {
    const at = lines.findIndex((l) => l.includes(id));
    if (at >= 0) { center = at + 1; break; }
  }
  if (center === 0 && line && line > 0 && line <= lines.length) center = line;
  if (center === 0) center = 1;

  const from = Math.max(0, center - 1 - SNIPPET_RADIUS);
  const to = Math.min(lines.length, center + SNIPPET_RADIUS);
  const cut = lines.slice(from, to).join('\n').slice(0, SNIPPET_MAX);

  // Обрезка названа вслух. Молчаливое окно читается как весь файл, и тогда
  // «в куске дефекта нет» превращается в «дефекта нет» — то самое враньё из
  // пустого места, ради которого всё это и делается.
  return [
    `[кусок обрезан: строки ${from + 1}-${to} из ${lines.length}; чего нет в куске — может быть в файле]`,
    cut,
  ].join('\n');
}

/** Один разбор. Провал — это `unjudged`, а не «шум». */
export async function judgeOne(f: Finding, retried = false): Promise<Judged> {
  const snippet = readSnippet(f.file_path, f.line_number, identifiersFrom(f));
  // ПД перед отправкой во внешнюю модель чистятся всегда: находка может
  // процитировать строку кода с телефоном или почтой (152-ФЗ, см.
  // lib/agents/compliance). Дешевле почистить, чем доказывать, что не было.
  const body = redactPII([
    `Категория: ${f.category}`,
    `Важность: ${f.severity}`,
    f.file_path ? `Файл: ${f.file_path}${f.line_number ? `:${f.line_number}` : ''}` : null,
    `Заголовок: ${f.title}`,
    f.description ? `Описание: ${f.description}` : null,
    f.suggestion ? `Предложение сканера: ${f.suggestion}` : null,
    // Код идёт ПОСЛЕ находки и назван кодом: находка старше него, и судья
    // должен видеть, что именно с чем сверяет.
    snippet
      ? `\nКОД СЕЙЧАС (${f.file_path}):\n${snippet}`
      : f.file_path
        ? `\nКода нет: файл ${f.file_path} не прочитан.`
        : '\nФайла эта находка не называет — она не о коде.',
  ].filter(Boolean).join('\n'));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: body },
  ];

  // Водопад решателя, а не голый callAnthropic. Три дня подряд (12-14.08)
  // отчёты выходили с «не разобрано: 30+ — модель не ответила»: Anthropic
  // отдавал пустой ответ, и на этом разбор заканчивался, хотя DeepSeek и
  // Qwen — штатный запасной путь решателя (CLAUDE.md §8: «для сильного
  // решателя достаточно DeepSeek/Qwen без релея»). Водопад пробует флагмана,
  // Anthropic напрямую, затем DeepSeek и Qwen — и штампует, кто ответил.
  const res = await callAIDecisionDetailed(messages);
  const answer = res.text;
  if (!answer) {
    // ПОЧЕМУ никто не ответил — водопад это знает и кладёт в `error` по
    // ступеням. Раньше поле выбрасывалось, и отчёт говорил «модель не
    // ответила» одинаково при отсутствующем ключе, гео-блоке, исчерпанной
    // квоте и таймауте. Разбор 18.08 вышел 41 из 41 неразобранным, среди них
    // была critical-инъекция, и восемь суток никто не знал, что чинить.
    return {
      finding: f,
      verdict: 'unjudged',
      reason: res.error ? `модель не ответила: ${res.error}`.slice(0, 300) : 'модель не ответила',
    };
  }

  const v = /ВЕРДИКТ:\s*(real|fixed|noise|needs_info)/i.exec(answer);
  const r = /ПРИЧИНА:\s*(.+)/i.exec(answer);
  if (!v) {
    // Ответ есть, но формы нет — это тоже «не разобрана». Догадываться о
    // вердикте по свободному тексту значит снова выдать неуверенность за вывод.
    //
    // Одна попытка переспросить — не догадка, а повтор вопроса: разбор сорван
    // формой ответа, а не существом дела, и молча терять находку из-за этого
    // дороже одного вызова. Вторая попытка не делается: если модель не держит
    // форму дважды, это уже про модель.
    if (!retried) {
      const again = await judgeOne(f, true);
      if (again.verdict !== 'unjudged') return again;
    }
    return { finding: f, verdict: 'unjudged', reason: 'ответ не в заданной форме', model: res.model };
  }
  return {
    finding: f,
    verdict: v[1].toLowerCase() as Verdict,
    reason: (r?.[1] ?? '').trim().slice(0, 200) || 'причина не названа',
    model: res.model,
  };
}

/**
 * Сколько находок разбирать за прогон.
 *
 * Было сорок — при том, что прод отдаёт до ста. Разницу съедала не стоимость,
 * а число, взятое с потолка: разбор шёл по одной находке за раз, и сорок
 * последовательных вызовов казались пределом времени джоба. Вызовы теперь
 * идут пачками, и потолок совпадает с тем, сколько находок вообще приходит.
 */
function judgeLimit(): number {
  const raw = parseInt(process.env.EVO_JUDGE_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
}

/** Номер прогона — им сдвигается окно добора. Нет номера — сдвига нет. */
function judgeOffset(): number {
  const raw = parseInt(process.env.EVO_JUDGE_OFFSET ?? '', 10);
  return Number.isFinite(raw) ? raw : 0;
}

/** Доля мест, которая ВСЕГДА достаётся началу очереди — то есть хвосту списка. */
const BACKLOG_SHARE = 0.75;

/** Важность, которая не встаёт в общую очередь. */
const SEVERE = new Set(['critical', 'high']);

function isSevere(f: Finding): boolean {
  return SEVERE.has((f.severity ?? '').trim().toLowerCase());
}

/**
 * Что разбирать, если находок больше потолка, и в каком порядке.
 *
 * Простой префикс `slice(0, N)` — не «разбор первых N», а НИКОГДА не разбор
 * остальных: порядок с прода один и тот же каждый прогон (важность, затем
 * дата), поэтому конец списка — низкое по важности и старое — не попадал в
 * разбор ни 18, ни 19 августа. Хвост при этом РОС: 18-го за потолком осталось
 * три находки, 19-го — восемь. Когда потолок сняли, в нём нашлась настоящая
 * утечка секрета, ждавшая с 16-го.
 *
 * Отсюда порядок очереди — решение владельца 19.08: **начинать с хвоста**.
 * Кто ждёт дольше всех, разбирается первым.
 *
 * Одно исключение названо явно: critical и high не встают в эту очередь.
 * Не по положению в списке, а по собственной важности — иначе правило
 * «сначала старое» однажды отодвинет свежую инъекцию за сотню заметок про
 * чужие анонсы моделей.
 *
 * Сдвиг окна остаётся: если однажды переполнится и хвост, без него
 * голодала бы уже свежая часть списка, и мы получили бы ту же болезнь с
 * другого конца.
 */
export function selectForJudging(
  findings: Finding[],
  limit: number,
  offset: number,
): { picked: Finding[]; skipped: Finding[] } {
  if (findings.length <= limit) return { picked: findings, skipped: [] };

  const severe = findings.filter(isSevere).slice(0, limit);
  // Хвостом вперёд: индекс 0 — самая старая и самая низкая по важности.
  const queue = findings.filter((f) => !isSevere(f)).reverse();
  const room = Math.max(0, limit - severe.length);

  // Начало очереди берётся ВСЕГДА, а не «когда до него дойдёт ротация»:
  // иначе «начинаем с хвоста» верно лишь в те прогоны, где сдвиг случайно
  // оказался нулевым, — то есть на словах. Остаток мест едет по очереди
  // дальше, чтобы не заголодала свежая часть списка.
  const fixed = Math.min(queue.length, Math.max(1, Math.floor(room * BACKLOG_SHARE)));
  const takenIdx = new Set<number>();
  for (let i = 0; i < fixed; i++) takenIdx.add(i);

  const rotating = room - fixed;
  const restLen = queue.length - fixed;
  if (rotating > 0 && restLen > 0) {
    const start = ((offset % restLen) + restLen) % restLen;
    for (let i = 0; i < Math.min(rotating, restLen); i++) {
      takenIdx.add(fixed + ((start + i) % restLen));
    }
  }

  const picked = [...severe, ...queue.filter((_, i) => takenIdx.has(i))];
  const pickedIds = new Set(picked);
  const skipped = findings.filter((f) => !pickedIds.has(f));
  return { picked, skipped };
}

/**
 * Разбор пачками. Последовательный цикл упирался во время джоба задолго до
 * того, как упёрся бы в деньги, — и именно он держал потолок в сорок находок.
 * Пачка небольшая намеренно: провайдеры водопада отвечают 429 на всплеск,
 * а 429 в этом скрипте означает «не разобрана» — то самое, что чиним.
 */
const BATCH = 4;

async function judgeAll(findings: Finding[]): Promise<Judged[]> {
  const out: Judged[] = [];
  for (let i = 0; i < findings.length; i += BATCH) {
    const batch = findings.slice(i, i + BATCH);
    // Исключение на одной находке не имеет права уносить пачку: соседи
    // разобраны, и их вердикты — факт. Упавшая становится «не разобрана»
    // с причиной, а не пропадает из отчёта молча.
    out.push(...(await Promise.all(batch.map((f) => judgeOne(f).catch((err: unknown): Judged => ({
      finding: f,
      verdict: 'unjudged',
      reason: `разбор упал: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    }))))));
  }
  return out;
}

/** Отчёт для GitHub Issue. Числа сверху, подробности ниже. */
export function renderReport(judged: Judged[]): string {
  const by = (v: Verdict) => judged.filter((j) => j.verdict === v);
  const real = by('real'), fixed = by('fixed'), noise = by('noise'),
    info = by('needs_info'), un = by('unjudged');

  const lines: string[] = [];
  lines.push(`Разобрано находок: **${judged.length}**`);
  // Атрибуция: по прошлым отчётам нельзя было отличить «Anthropic молчит»
  // от «ключа нет» — модель судьи теперь названа в отчёте фактом.
  const models = [...new Set(judged.map((j) => j.model).filter(Boolean))] as string[];
  if (models.length > 0) lines.push(`Судья: ${models.join(', ')}`);
  lines.push('');
  lines.push('| Вердикт | Сколько |');
  lines.push('|---|---|');
  lines.push(`| по делу | ${real.length} |`);
  lines.push(`| уже починено | ${fixed.length} |`);
  lines.push(`| шум | ${noise.length} |`);
  lines.push(`| мало данных | ${info.length} |`);
  lines.push(`| не разобрана | ${un.length} |`);
  lines.push('');

  if (un.length > 0) {
    // Названо отдельно и до подробностей: неразобранное легко принять за
    // «ничего не нашли», а это разные вещи.
    lines.push(`> Не разобрано: ${un.length}. Это не «чисто» — это отсутствие ответа.`);
    lines.push('');
    // Причины — списком РАЗЛИЧНЫХ, а не по разу на находку: сорок одинаковых
    // строк «модель не ответила: deepseek: ключа нет» прячут ответ, ради
    // которого их печатают.
    const reasons = [...new Set(un.map((j) => j.reason))];
    if (reasons.length > 0 && un.length === judged.length) {
      lines.push('Разобрать не удалось НИ ОДНОЙ находки. Причины по ступеням решателя:');
      for (const r of reasons.slice(0, 5)) lines.push(`- ${r}`);
      lines.push('');
    }
  }

  for (const [title, group] of [
    ['По делу', real], ['Мало данных', info], ['Уже починено', fixed],
    ['Шум', noise], ['Не разобрано', un],
  ] as Array<[string, Judged[]]>) {
    if (group.length === 0) continue;
    lines.push(`## ${title}`);
    for (const j of group) {
      const where = j.finding.file_path
        ? ` — \`${j.finding.file_path}${j.finding.line_number ? `:${j.finding.line_number}` : ''}\``
        : '';
      lines.push(`- **${j.finding.title}**${where}`);
      lines.push(`  ${VERDICT_RU[j.verdict]}: ${j.reason}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    throw new Error('Использование: evo-judge.ts <находки.json> <отчёт.md>');
  }
  // Отсутствие ВСЕХ ключей — это отказ, а не пустой разбор. Водопаду решателя
  // хватает ЛЮБОГО из путей, и OpenRouter в этом списке первый по порядку
  // вызова — но до 19.08 его тут не было. Значит, заведя только его, владелец
  // получил бы отказ «нет ни одного ключа» при живом ключе: проверка знала не
  // те имена, что зовёт водопад.
  const KEYS = ['OPENROUTER_API_KEY', 'OR_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];
  if (!KEYS.some((k) => process.env[k])) {
    throw new Error(`Нет ни одного ключа модели (${KEYS.join('/')}): разбирать нечем. Пустой отчёт был бы враньём.`);
  }

  const raw = JSON.parse(readFileSync(inPath, 'utf-8')) as { issues?: Finding[] };
  const findings = Array.isArray(raw.issues) ? raw.issues : [];
  if (findings.length === 0) {
    writeFileSync(outPath, 'Открытых находок нет.\n');
    return;
  }

  const limit = judgeLimit();
  const { picked, skipped } = selectForJudging(findings, limit, judgeOffset());

  const judged = await judgeAll(picked);

  if (skipped.length > 0) {
    // Потолок назван вслух: молчаливая обрезка читается как «разобрали всё».
    judged.push({
      finding: { id: '', category: '', severity: '', file_path: null, line_number: null,
        title: `Ещё ${skipped.length} находок не разбирались (потолок прогона в ${limit})`,
        description: null, suggestion: null },
      verdict: 'unjudged',
      reason: `за потолком в ${limit}; окно сдвигается каждый прогон, эти попадут в следующий`,
    });
  }

  writeFileSync(outPath, renderReport(judged));
}

// Запуск только как скрипт: при импорте из теста main не вызывается.
if (process.argv[1] && process.argv[1].endsWith('evo-judge.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
