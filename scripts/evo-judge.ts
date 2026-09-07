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
import { createHash } from 'node:crypto';
import { callAIDecisionDetailed, checkOpenRouterBalance } from '@/lib/ai/providers';
import { redactPII } from '@/lib/security/pii-redact';
import type { ChatMessage } from '@/lib/ai/prompts';

export interface Finding {
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
  /** Кто отказал ДО неё: ступени водопада, не давшие ответа. */
  provenance?: string[];
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
    return { finding: f, verdict: 'unjudged', reason: 'ответ не в заданной форме', model: res.model ?? undefined, provenance: res.provenance };
  }
  return {
    finding: f,
    verdict: v[1].toLowerCase() as Verdict,
    reason: (r?.[1] ?? '').trim().slice(0, 200) || 'причина не названа',
    model: res.model ?? undefined,
    provenance: res.provenance,
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

/**
 * Сдвиг окна добора. Раньше им был номер прогона (`github.run_number`) — и
 * это ломало идемпотентность отчёта: marker-push в 09:07 и запоздавший
 * scheduled прогон того же дня в 17:38 получали РАЗНЫЕ номера при ОДНОМ и том
 * же входе, окно добора сдвигалось на пустом месте, и `input_hash` расходился
 * без единого смыслового отличия во входе (задание владельца 27.08 —
 * идемпотентный Judge-report).
 *
 * Сдвиг теперь — УТС-сутки: `floor(now / 86400000)`. Marker и запоздавший
 * scheduled прогон одного календарного дня выбирают одно и то же окно; на
 * следующие сутки окно едет само, без внешнего счётчика. `EVO_JUDGE_OFFSET`
 * остаётся явным оверрайдом — для тестов и на случай ручного разбора.
 */
function judgeOffset(): number {
  const raw = parseInt(process.env.EVO_JUDGE_OFFSET ?? '', 10);
  if (Number.isFinite(raw)) return raw;
  return Math.floor(Date.now() / 86_400_000);
}

/** За сколько дней окно отчёта — часть его identity (report_key), не только фильтр входа. */
function judgeDays(): number {
  const raw = parseInt(process.env.EVO_JUDGE_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
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
/**
 * Два жанра под одной крышей.
 *
 * evo_growth_issues держит и находки сканера кода (утверждения о конкретных
 * строках), и находки моста разведки — intel-bridge превращает дайджест Scout
 * в «возможности» вроде «исследовать RAG» или «внедрить дашборд». Это
 * законные записи, человек решает по ним отдельно, но УТВЕРЖДЕНИЯМИ О КОДЕ
 * они не являются.
 *
 * Разбор 23.08 показал цену смешения: 34 «шума» из 45, и почти все —
 * разведданные. Судья отвечал верно (его промпт прямо велит считать шумом
 * предложения изучить и внедрить), но ответ был известен заранее, а платили
 * за него токенами флагмана. Хуже другое: цифра «шум 34» читается как
 * точность сканера кода, которой она не является.
 *
 * Поэтому разведданные не судятся, а называются числом и списком. Жанр
 * берётся из КАТЕГОРИИ, то есть из данных, а не угадывается по тексту:
 * находка сканера без файла останется в разборе и получит честный вердикт.
 */
export function splitGenres(
  findings: Finding[],
): { claims: Finding[]; intel: Finding[] } {
  const intel = findings.filter((f) => f.category === 'intel');
  const claims = findings.filter((f) => f.category !== 'intel');
  return { claims, intel };
}

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
 * ── Идемпотентность отчёта ──────────────────────────────────────────────────
 *
 * `schedule`, marker `push` и ручной запуск разбирают ОДИН И ТОТ ЖЕ прод-
 * снимок, доставленный по-разному: планировщик GitHub деградирует и
 * доставляет очередь с многочасовым опозданием (27.08 — marker в 09:07,
 * запоздавший scheduled той же очереди в 17:38). Раньше каждый успешный
 * прогон безусловно заводил новый GitHub Issue — то есть один и тот же
 * анализ издавался дважды, а `github.run_id`/`github.run_number`/тип события/
 * время старта не годятся в ключ идентичности: у двух ДОСТАВОК одной работы
 * они разные.
 *
 * Отсюда три разных отпечатка (задание владельца 27.08):
 *  - `input_hash`  — что именно судили (canonical JSON отобранных находок +
 *    хеш очищенного куска кода на файл); не входят run_id, время, баланс,
 *    модель — они метаданные ЗАПУСКА, а не входа;
 *  - `output_hash` — что ответила модель (id + вердикт + причина + модель по
 *    каждой находке), без баланса и timestamp;
 *  - `decision_hash` — то, что реально требует внимания владельца: только
 *    `real`/`needs_info`/`unjudged` (плюс intel) — «шум» и «починено» не
 *    меняют этот отпечаток, иначе стилистически иной текст читался бы как
 *    новое решение.
 *
 * Публикует (`scripts/evo-judge-publish.ts`) один канонический Issue на
 * `report_key` и обновляет его на месте, когда отпечаток не изменился —
 * вместо нового выпуска на каждую доставку одного и того же снимка.
 */

/** Ревизия контракта судьи. Поднимать при смене SYSTEM-промпта, формы ответа
 *  или правил отбора — правки комментариев и форматирования её не трогают. */
export const JUDGE_CONTRACT_VERSION = 'judge-v1';

/** Проекция для человека: один канонический Issue на окно анализа. */
export function reportKey(days: number): string {
  return `evo-judge:window:${days}d:v1`;
}

export function reportTitle(days: number): string {
  return `Evo Judge — актуальный разбор (${days} дней)`;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf-8').digest('hex')}`;
}

/** Стабильный порядок ключей объекта — иначе один и тот же смысл сериализуется по-разному. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
    return sorted;
  }
  return value;
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Кусок кода находки, очищенный от ПД и свёрнутый в хеш — сравнивать входы, не хранить снимки кода в отпечатке. */
function hashSnippet(f: Finding): string | null {
  const snippet = readSnippet(f.file_path, f.line_number, identifiersFrom(f));
  return snippet ? sha256(redactPII(snippet)) : null;
}

export interface PreparedFinding extends Finding {
  redacted_snippet_sha256: string | null;
}

export interface PreparedJudgeInput {
  schema: 1;
  judge_contract_version: string;
  days: number;
  offset: number;
  picked: PreparedFinding[];
  skipped_ids: string[];
  intel: Array<{ id: string; title: string }>;
}

/**
 * Вход судьи ДО вызова модели: отбор (selectForJudging), очистка ПД и хеш
 * куска кода. Определяет, нужно ли снова тратить токены — считается
 * ДО обращения к модели, а не после.
 */
export function prepareJudgeInput(
  all: Finding[],
  options: { days: number; limit?: number; offset?: number },
): PreparedJudgeInput {
  const { claims, intel } = splitGenres(all);
  const limit = options.limit ?? judgeLimit();
  const offset = options.offset ?? judgeOffset();
  const { picked, skipped } = selectForJudging(claims, limit, offset);
  return {
    schema: 1,
    judge_contract_version: JUDGE_CONTRACT_VERSION,
    days: options.days,
    offset,
    picked: picked.map((f) => ({ ...f, redacted_snippet_sha256: hashSnippet(f) })),
    skipped_ids: skipped.map((f) => f.id),
    intel: intel.map((f) => ({ id: f.id, title: f.title })),
  };
}

export function hashJudgeInput(prepared: PreparedJudgeInput): string {
  return sha256(canonicalJSON(prepared));
}

/** Записи-заглушки (например «ещё N не разбирались») не находки — у них пустой id, в отпечаток не входят. */
function isRealFinding(j: Judged): boolean {
  return j.finding.id !== '';
}

export function hashJudgeOutput(judged: Judged[], intel: Array<{ id: string; title: string }>): string {
  const results = judged
    .filter(isRealFinding)
    .map((j) => ({ id: j.finding.id, verdict: j.verdict, reason: j.reason, model: j.model ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalJSON({ results, intel: [...intel].map((f) => f.id).sort() }));
}

/** Владельцу требует внимания: real/needs_info/unjudged и intel — «шум»/«починено» этот отпечаток не меняют. */
const ACTIONABLE_VERDICTS = new Set<Verdict>(['real', 'needs_info', 'unjudged']);

/** Разбор молчал по ВСЕЙ выборке — отдельный факт отпечатка: смена reason не создаёт новое решение, смена этого — создаёт. */
export function isDegraded(judged: Judged[]): boolean {
  return judged.length > 0 && judged.every((j) => j.verdict === 'unjudged');
}

export function hashOwnerDecisions(judged: Judged[], intel: Array<{ id: string; title: string }>): string {
  const actionable = judged
    .filter((j) => isRealFinding(j) && ACTIONABLE_VERDICTS.has(j.verdict))
    .map((j) => ({ id: j.finding.id, verdict: j.verdict }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalJSON({
    actionable,
    intel: [...intel].map((f) => f.id).sort(),
    system_failure: isDegraded(judged),
  }));
}

export function countActionable(judged: Judged[], intel: Array<{ id: string; title: string }>): number {
  return judged.filter((j) => isRealFinding(j) && ACTIONABLE_VERDICTS.has(j.verdict)).length + intel.length;
}

export interface ReportMeta {
  schema: 1;
  report_key: string;
  title: string;
  input_hash: string;
  output_hash: string;
  decision_hash: string;
  actionable: number;
  analysis_status: 'complete' | 'degraded';
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
/**
 * Строка о счёте OpenRouter.
 *
 * Четверо суток (16-19.08) разбор молчал, и причину читали из ТЕЛА ОШИБКИ
 * модели — «Credit balance is too low». Спросить счёт напрямую было можно
 * всё это время: checkOpenRouterBalance() написана давно и не имела НИ ОДНОГО
 * потребителя — тот же сюжет, что с validateRoutePost в июле.
 *
 * `null` — не «денег нет», а «не спросили»: ключа управления нет или сам
 * запрос не прошёл. Третий исход отличим от первых двух (CLAUDE.md §4.0).
 */
export function balanceLine(b: Awaited<ReturnType<typeof checkOpenRouterBalance>>): string {
  if (!b) return 'Счёт OpenRouter: не спросили (нет ключа управления или запрос не прошёл).';
  if (b.remaining === null) {
    return `Счёт OpenRouter: постоплата, жёсткого лимита нет · потрачено $${b.total_usage}.`;
  }
  const warn = b.low ? ' — НА ИСХОДЕ' : '';
  return `Счёт OpenRouter: осталось $${b.remaining}${warn} (начислено $${b.total_credits}, потрачено $${b.total_usage}).`;
}

export function renderReport(judged: Judged[], balance?: string, intel: Array<{ title: string }> = []): string {
  const by = (v: Verdict) => judged.filter((j) => j.verdict === v);
  const real = by('real'), fixed = by('fixed'), noise = by('noise'),
    info = by('needs_info'), un = by('unjudged');

  const lines: string[] = [];
  lines.push(`Разобрано находок: **${judged.length}**`);
  // Счёт — сразу под числом находок: «не разобрано» и «денег нет» перестают
  // быть загадкой, которую читают из текста чужой ошибки.
  if (balance) lines.push(balance);
  // Атрибуция: по прошлым отчётам нельзя было отличить «Anthropic молчит»
  // от «ключа нет» — модель судьи теперь названа в отчёте фактом.
  const models = [...new Set(judged.map((j) => j.model).filter(Boolean))] as string[];
  if (models.length === 1) lines.push(`Судья: ${models[0]}`);
  lines.push('');

  // Когда судей несколько, «Судья: A, B, C» скрывает главное: часть вердиктов
  // вынесена НЕ сильнейшей моделью, а запасной, и какие именно — не видно.
  // Внутри водопада подмена тихая: сильнейшая молчит — отвечает следующая,
  // ответ приходит, отличить его нечем. Разбор 19.08 шёл тремя моделями сразу.
  if (models.length > 1) {
    lines.push('Судьи разные — сила суждения неодинакова:');
    lines.push('');
    lines.push('| Модель | Вердиктов |');
    lines.push('|---|---|');
    for (const m of models) {
      lines.push(`| ${m} | ${judged.filter((j) => j.model === m).length} |`);
    }
    lines.push('');

    // ПОЧЕМУ отвечала не первая ступень. Причины лежат в provenance каждого
    // вердикта и раньше выбрасывались: их печатали только при полной немоте,
    // то есть ровно тогда, когда чинить уже поздно.
    const fell = judged.filter((j) => (j.provenance?.length ?? 0) > 0);
    const reasons = new Map<string, number>();
    for (const j of fell) {
      for (const r of j.provenance ?? []) reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    if (reasons.size > 0) {
      lines.push(`Почему отвечала не первая ступень (${fell.length} из ${judged.length}):`);
      for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        lines.push(`- ${r} — ${n}`);
      }
      lines.push('');
    }
  }
  lines.push('| Вердикт | Сколько |');
  lines.push('|---|---|');
  lines.push(`| по делу | ${real.length} |`);
  lines.push(`| уже починено | ${fixed.length} |`);
  lines.push(`| шум | ${noise.length} |`);
  lines.push(`| мало данных | ${info.length} |`);
  lines.push(`| не разобрана | ${un.length} |`);
  lines.push('');

  // Разведданные названы вслух и числом. Молчаливое исключение читалось бы
  // как «их не было», а они были и стоят решения человека — просто не того,
  // которое выносит судья кода.
  if (intel.length > 0) {
    lines.push(`Разведданных (не судятся): **${intel.length}**. Это заметки моста разведки, а не утверждения о коде: вопрос «это дефект?» им не задаётся, потому что ответ известен заранее и стоит токенов.`);
    lines.push('');
  }

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

  const manyModels = models.length > 1;
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
      // Модель — рядом с вердиктом, а не только в шапке: читающий решает по
      // строке, и знать, кто её вынес, надо в ней же.
      const by = manyModels && j.model ? ` · ${j.model}` : '';
      lines.push(`  ${VERDICT_RU[j.verdict]}${by}: ${j.reason}`);
    }
    lines.push('');
  }
  if (intel.length > 0) {
    lines.push('## Разведданные (не судятся)');
    lines.push('');
    lines.push('Решение по ним — человека, и вопрос к ним другой: стоит ли этим заниматься, а не «сломано ли это».');
    lines.push('');
    for (const f of intel) lines.push(`- ${f.title}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const [inPath, outPath, metaPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    throw new Error('Использование: evo-judge.ts <находки.json> <отчёт.md> [meta.json]');
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

  // Счёт спрашивается ДО разбора: если денег нет, это должно быть написано в
  // отчёте, а не выведено человеком из сорока шести одинаковых отказов.
  const balance = balanceLine(await checkOpenRouterBalance());
  console.log(balance);

  const raw = JSON.parse(readFileSync(inPath, 'utf-8')) as { issues?: Finding[] };
  const all = Array.isArray(raw.issues) ? raw.issues : [];
  const days = judgeDays();

  // Один и тот же prepareJudgeInput кормит и разбор, и три отпечатка ниже:
  // «что судили» гарантированно совпадает с тем, что попало в input_hash.
  const prepared = prepareJudgeInput(all, { days });
  const judged: Judged[] = prepared.picked.length > 0 ? await judgeAll(prepared.picked) : [];

  if (prepared.skipped_ids.length > 0) {
    // Потолок назван вслух: молчаливая обрезка читается как «разобрали всё».
    judged.push({
      finding: { id: '', category: '', severity: '', file_path: null, line_number: null,
        title: `Ещё ${prepared.skipped_ids.length} находок не разбирались (потолок прогона в ${judgeLimit()})`,
        description: null, suggestion: null },
      verdict: 'unjudged',
      reason: `за потолком в ${judgeLimit()}; окно сдвигается каждый прогон, эти попадут в следующий`,
    });
  }

  writeFileSync(
    outPath,
    all.length === 0 ? `Открытых находок нет.\n\n${balance}\n` : renderReport(judged, balance, prepared.intel),
  );

  if (metaPath) {
    const meta: ReportMeta = {
      schema: 1,
      report_key: reportKey(days),
      title: reportTitle(days),
      input_hash: hashJudgeInput(prepared),
      output_hash: hashJudgeOutput(judged, prepared.intel),
      decision_hash: hashOwnerDecisions(judged, prepared.intel),
      actionable: countActionable(judged, prepared.intel),
      analysis_status: isDegraded(judged) ? 'degraded' : 'complete',
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

// Запуск только как скрипт: при импорте из теста main не вызывается.
if (process.argv[1] && process.argv[1].endsWith('evo-judge.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
