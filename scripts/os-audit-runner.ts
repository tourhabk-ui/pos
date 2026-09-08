/**
 * scripts/os-audit-runner.ts — аудит ОС и эволюции одним проходом.
 *
 * Владелец 08.09: «может Astra проведёт аудит ОС и эволюции, может мы тоже
 * упустили что-то».
 *
 * ── Почему это осмысленно ──────────────────────────────────────────────────
 *
 * Мы судим платформу по кусочкам: сторож проверяет своё, перепись считает
 * своё, ревью смотрит диф. Ни один из них не держит перед глазами ПРАВИЛА и
 * ИСПОЛНЕНИЕ одновременно, а расхождение между ними живёт именно там.
 *
 * За один сегодняшний день нашлось четыре таких расхождения, и ни одно не
 * поймал ни один сторож:
 *
 *   - `search_text` в представлении объявлен `NULL::tsvector` — поиск мест
 *     Кузьмича падал на каждом вызове, отказ глотал `catch`;
 *   - правило старшинства линии было скопировано в девять мест и разошлось;
 *   - ожидание выкладки отчитывалось успехом, не дождавшись;
 *   - сторож `track-import-queue-read` резал файл от исчезнувшей константы и
 *     молча проверял пустоту.
 *
 * Модель с контекстом на миллион читает правила, реализацию и сторожей
 * ЦЕЛИКОМ и может увидеть то, что видно только рядом.
 *
 * ── Почему находке можно верить ────────────────────────────────────────────
 *
 * Не на слово. Каждая обязана ссылаться на файл ИЗ ВЫДАННОГО НАБОРА; ссылка
 * на файл вне набора — признак выдумки: находка выбрасывается и считается
 * отдельным числом. Тот же приём, что у `finding-guard` и у разбора
 * маршрутов.
 *
 * Аудит ничего не меняет и ничего не решает: печатает находки, решает человек.
 *
 * Использование: npx tsx scripts/os-audit-runner.ts <модель> [<glob> ...]
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { salvageTruncatedArray } from '../lib/ai/json-salvage';
import { openRouterAttribution } from '../lib/ai/attribution';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const RUB_PER_USD = 135; // §8
/** Потолок набора: миллионный контекст велик, но платим за каждый токен. */
const BUNDLE_LIMIT_BYTES = 1_800_000;

/** Что читаем по умолчанию: правила, исполнение, сторожа этих же агентов. */
const DEFAULT_TARGETS = [
  'CLAUDE.md',
  'AGENTS.md',
  'lib/agents',
  'lib/ai/providers.ts',
  'lib/ai/model-resolver.ts',
];
/** Сторожа берутся по имени: аудит про агентов, а не про весь репозиторий. */
const GUARD_PATTERN = /(cron|evo|watchdog|agent|scout|editor)/;

interface Bundled { path: string; text: string }

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (/\.(ts|tsx|md)$/.test(full)) out.push(full);
  }
}

function collect(targets: string[]): { files: Bundled[]; skipped: number; bytes: number } {
  const root = process.cwd();
  const paths: string[] = [];
  for (const t of targets) {
    // Цель приходит из аргументов запуска — тоже снаружи. Читаем только то,
    // что после нормализации осталось внутри дерева репозитория.
    const full = resolve(root, t);
    if (!full.startsWith(resolve(root) + sep) || !existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, paths);
    else paths.push(full);
  }
  for (const f of readdirSync(join(root, 'tests/unit'))) {
    if (/\.test\.ts$/.test(f) && GUARD_PATTERN.test(f)) paths.push(join(root, 'tests/unit', f));
  }

  const files: Bundled[] = [];
  let bytes = 0;
  let skipped = 0;
  for (const p of paths.sort()) {
    const text = readFileSync(p, 'utf8');
    if (bytes + text.length > BUNDLE_LIMIT_BYTES) { skipped += 1; continue; }
    bytes += text.length;
    files.push({ path: relative(root, p), text });
  }
  return { files, skipped, bytes };
}

const SYSTEM = `Ты проводишь аудит платформы «Ведар» (туризм и безопасность на Камчатке) по её собственным исходникам.

Тебе выдан набор файлов: ПРАВИЛА платформы (CLAUDE.md, AGENTS.md), РЕАЛИЗАЦИЯ агентов и АВТОМАТИЧЕСКИЕ СТОРОЖА (tests/unit/*.test.ts).

Ищи расхождения, которые видны ТОЛЬКО при взгляде на всё сразу:

1. Правило записано в CLAUDE.md, но код его не исполняет (или исполняет иначе).
2. Одно правило реализовано в нескольких местах и копии разошлись между собой.
3. Сторож существует, но по факту ничего не проверяет: якорь съехал, срез пуст, условие всегда истинно.
4. Отказ проглатывается: пустой catch, \`return null\` без причины, «ошибка» неотличима от «данных нет».
5. Проверка с двумя исходами там, где нужен третий — «не смог проверить» (правило §4.0 «третьего состояния»).
6. Заявленное расписание или поведение агента не подтверждается кодом.

И ОТДЕЛЬНО — второй род работы, не менее важный, чем первый.

УСИЛЕНИЕ: чего платформе не хватает, чтобы быть лучшей в своём деле.
Не дефект, а следующий шаг: механизм, которого нет, но который здесь
напрашивается — потому что рядом уже есть половина, или потому что правило
записано, а инструмента под него нет, или потому что похожая задача в
соседнем месте решена сильнее.

Предложение подчиняется той же дисциплине, что и находка: оно обязано
опираться на ДОСЛОВНУЮ улику из выданных файлов — что именно уже есть, от
чего отталкиваемся. Предложение без улики — фантазия, и оно будет отброшено
тем же ситом, что и выдуманная находка.

Чего в предложениях НЕ надо:
- общих слов «добавить мониторинг», «улучшить архитектуру», «внедрить ИИ»;
- переписывания того, что работает, ради красоты;
- чужих модных практик без связи с тем, что здесь уже есть;
- предложений, которые нельзя проверить кодом или замером.

Хорошее предложение звучит так: «здесь уже есть X (цитата), рядом в Y это
решено сильнее (цитата) — перенести приём» или «правило Z записано в
CLAUDE.md (цитата), но инструмента под него нет ни одного».

ЖЁСТКИЕ ПРАВИЛА (нарушение делает находку бесполезной):
- Ссылайся ТОЛЬКО на пути файлов из выданного набора. Не сочиняй путей.
- В evidence приводи ДОСЛОВНЫЕ фрагменты кода или текста из выданных файлов.
- Не предполагай содержимое файлов, которых в наборе нет.
- Безопасность туриста важнее всего: находки про SOS, офлайн, тревоги и Кузьмича ставь выше.
- Лучше десять находок с уликами, чем сто догадок.

Ответь СТРОГО одним JSON-объектом:
{"findings":[{"severity":"high|medium|low","kind":"rule_not_enforced|rule_duplicated|guard_toothless|failure_swallowed|missing_third_state|declared_not_real|strengthening","files":["путь"],"what":"суть одной фразой","evidence":"дословно из файлов","proposal":"что делать"}]}

Род \`strengthening\` — для предложений усиления. Остальные шесть — для дефектов.`;

interface Finding {
  severity?: string; kind?: string; files?: string[];
  what?: string; evidence?: string; proposal?: string;
}

function parseFindings(raw: string): { findings: Finding[]; note: string | null; error: string | null } {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : raw).trim();
  const start = body.indexOf('{');
  if (start < 0) return { findings: [], note: null, error: 'в ответе нет JSON-объекта' };
  const end = body.lastIndexOf('}');
  if (end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as { findings?: unknown };
      if (Array.isArray(parsed.findings)) return { findings: parsed.findings as Finding[], note: null, error: null };
    } catch { /* ниже спасение оборванного */ }
  }
  const arrAt = body.indexOf('[', start);
  if (arrAt < 0) return { findings: [], note: null, error: 'в ответе нет массива findings' };
  const salvaged = salvageTruncatedArray(body.slice(arrAt));
  if (salvaged.length === 0) return { findings: [], note: null, error: 'ответ оборван, целых находок не спасти' };
  return { findings: salvaged as Finding[], note: `ответ ОБОРВАН; спасено целых находок: ${salvaged.length}`, error: null };
}

/**
 * Улика обязана НАЙТИСЬ в файле, на который ссылается находка.
 *
 * Владелец 08.09: «без уточнения первые ответы у моделей поверхностные и
 * больше на предположениях строятся». Проверка существования пути этого не
 * ловит: путь настоящий, а утверждение о его содержимом — пересказ по памяти.
 *
 * Поэтому из `evidence` вырезаются осмысленные куски (в кавычках, в обратных
 * кавычках или просто длинные строки), и хотя бы один обязан встретиться в
 * тексте одного из названных файлов ДОСЛОВНО — с точностью до схлопнутых
 * пробелов. Пересказ такую проверку не проходит, цитата проходит.
 *
 * Это дёшево (ни одного вызова модели) и подделать это нечем.
 */
/**
 * Файл, названный проверяющим как недостающий, — читаем с диска.
 *
 * Третий круг имеет смысл ТОЛЬКО если приносит новый материал: повторный
 * вопрос без новых данных даёт тот же поверхностный ответ. Поэтому читаем
 * ровно то, что второй круг назвал недостающим, и ничего сверх.
 */
/**
 * Путь, названный МОДЕЛЬЮ, — заявка, а не адрес.
 *
 * Между «модель назвала файл» и «мы его прочли и отправили в чужую LLM»
 * обязана стоять дверь: иначе достаточно назвать `.env.local`, и ключи
 * уедут в OpenRouter вместе с находкой. Дверь одна на все чтения:
 *
 *   - форма имени: сегменты из букв, цифр, `-` и точек — значит `..` внутрь
 *     не пройдёт и скрытые каталоги тоже (единственное исключение —
 *     `.github/`, где живут расписания кронов, а секретов нет);
 *   - расширение из списка: исходник, правило, миграция, конфиг;
 *   - после нормализации путь обязан остаться ВНУТРИ дерева репозитория.
 *
 * Отказ — пустая строка: третий круг просто не получит нового материала.
 */
const SEGMENT = String.raw`[\w-]+(?:\.[\w-]+)*`;
const SAFE_REL = new RegExp(`^(?:\\.github/)?${SEGMENT}(?:/${SEGMENT})*$`);
const READABLE_EXT = /\.(?:ts|tsx|md|sql|json|ya?ml)$/;

export function safeRepoPath(rel: string): string | null {
  const t = rel.trim().replace(/^\.\//, '');
  if (t === '' || !SAFE_REL.test(t) || !READABLE_EXT.test(t)) return null;
  const root = resolve(process.cwd());
  const full = resolve(root, t);
  if (!full.startsWith(root + sep)) return null;
  return full;
}

/**
 * Одно чтение на всё: сперва дверь, потом ПОПЫТКА, а не расспрос.
 *
 * Спрашивать `existsSync`, а читать следующей строкой — значит судить о
 * файле по его прошлому: между вопросом и ответом он успевает исчезнуть,
 * и вместо честного «не смог» прилетает исключение из середины разбора.
 * Поэтому проверки существования нет вовсе: `null` — не прочли, и это
 * ровно тот третий исход, которого требует §4.0.
 */
function tryReadRepoFile(rel: string): string | null {
  const full = safeRepoPath(rel);
  if (full === null) return null;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

function readIfExists(rel: string): string {
  return tryReadRepoFile(rel) ?? '';
}

/**
 * Имена файлов репозитория, названные в тексте «чего не хватило».
 *
 * Проверяющий пишет по-русски; выцепляем то, что похоже на путь, и берём
 * только реально существующее — выдуманный путь новым материалом не является.
 */
export function namedFiles(missing: string): string[] {
  const out: string[] = [];
  // Разрезаем по всему, что путём быть не может, и судим КАЖДЫЙ кусок целиком:
  // сканирующий поиск по классу, где точка и буква лежат вместе, перебирает
  // ответ модели квадратично, а якорная проверка — нет.
  for (const token of missing.split(/[^\w./-]+/)) {
    const rel = token.replace(/^\.\//, '').replace(/\.+$/, '');
    // Существование доказывает удавшееся чтение, а не отдельный вопрос о нём.
    if (tryReadRepoFile(rel) !== null) out.push(rel);
  }
  return [...new Set(out)];
}

const VERIFY_SYSTEM = `Ты ПРОВЕРЯЕШЬ одно утверждение о коде, а не ищешь новые.

Тебе выдан полный текст названных файлов и утверждение аудита.

Работай в таком порядке, и это важнее вежливости:

1. Сначала назови, ЧТО ДОЛЖНО БЫТЬ ВИДНО в выданном тексте, если утверждение верно, и что было бы видно, если оно неверно. Две разные приметы, а не одна.
2. Потом найди в тексте ту или другую. Цитируй дословно.
3. Только после этого выноси исход.

Будь придирчив к правдоподобию. Утверждение, звучащее убедительно, но не следующее из выданного текста, — НЕ подтверждается. Общие рассуждения о том, как обычно бывает в таком коде, доказательством не являются.

Три исхода, и третий обязателен:
  confirmed   — примета «верно» найдена в тексте, цитата приведена;
  refuted     — найдена примета «неверно»;
  cannot_tell — ни одной приметы в выданном нет.

«Не могу проверить» — это НЕ «подтверждается». Ставь его без стеснения.

Если ставишь cannot_tell, обязательно скажи в поле missing, ЧЕГО КОНКРЕТНО не хватило: имя файла, которого нет в выданном, или то, что видно лишь во время работы (лог, ответ базы, замер). Пиши имя файла так, как оно выглядит в репозитории.

Ответь СТРОГО одним JSON-объектом:
{"verdict":"confirmed|refuted|cannot_tell","expect_if_true":"примета верности","expect_if_false":"примета неверности","why":"дословная цитата и вывод","missing":"чего не хватило (только для cannot_tell)"}`;

interface Verdict { verdict?: string; why?: string; missing?: string }

/**
 * Второй заход по каждой находке — потому что первый ответ модели поверхностен.
 *
 * Владелец 08.09: «без уточнения первые ответы у моделей поверхностные и
 * больше на предположениях строятся». Это подтвердилось на мне трижды за
 * сутки: заглушки провайдеров, «И-семантика» запроса, «потерянный слот» —
 * все три были первыми ответами и все три оказались неверны.
 *
 * Проверяющему НЕ показывают ни остальной набор, ни прочие находки: только
 * названные файлы целиком и одно утверждение. Так он судит текст, а не
 * связность рассказа.
 */
async function verifyFinding(
  key: string, model: string, f: Finding, byPath: Map<string, string>, extra: string[] = [],
): Promise<{ verdict: string; why: string; missing: string; outOfFunds?: boolean }> {
  const paths = [...new Set([...(f.files ?? []), ...extra])];
  const bundle = paths
    .map((p) => `=== ФАЙЛ: ${p} ===\n${byPath.get(p) ?? readIfExists(p)}`)
    .join('\n\n');
  const claim = `Утверждение: ${f.what ?? ''}\nРод: ${f.kind ?? ''}\nУлика из аудита: ${f.evidence ?? ''}`;
  try {
    const res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${key}`, ...openRouterAttribution('os audit verify') },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: VERIFY_SYSTEM },
          { role: 'user', content: `${bundle}\n\n=== ПРОВЕРЯЕМОЕ ===\n${claim}` },
        ],
        max_tokens: 900,
        ...(modelProfile(model).sampling ? { temperature: 0 } : {}),
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      // 402 — не «не смог проверить эту находку», а «денег больше нет ни на
      // одну». Различать обязательно: иначе раннер тринадцать раз подряд
      // ходит за одним и тем же отказом и печатает тринадцать одинаковых
      // строк, из которых не видно, что случилось на самом деле.
      return {
        verdict: 'cannot_tell',
        why: `проверяющий не ответил: HTTP ${res.status}`,
        missing: '',
        outOfFunds: res.status === 402,
      };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    const at = text.indexOf('{');
    const to = text.lastIndexOf('}');
    if (at < 0 || to <= at) return { verdict: 'cannot_tell', why: 'ответ проверяющего не разобран', missing: '' };
    const v = JSON.parse(text.slice(at, to + 1)) as Verdict;
    const verdict = v.verdict === 'confirmed' || v.verdict === 'refuted' ? v.verdict : 'cannot_tell';
    return { verdict, why: v.why ?? '', missing: v.missing ?? '' };
  } catch (err) {
    // Отказ проверки — «не смог», а не «подтверждено» (§4.0).
    return { verdict: 'cannot_tell', why: err instanceof Error ? err.message : String(err), missing: '' };
  }
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

export function evidenceFragments(evidence: string): string[] {
  const out: string[] = [];
  for (const re of [/«([^»]{12,})»/g, /"([^"]{12,})"/g, /`([^`]{12,})`/g]) {
    for (const m of evidence.matchAll(re)) out.push(m[1]);
  }
  // Кавычек может не быть вовсе — тогда судим по длинным строкам.
  if (out.length === 0) {
    for (const line of evidence.split(/[\n;]/)) {
      const t = line.trim();
      if (t.length >= 20) out.push(t);
    }
  }
  return out.map(squash).filter((t) => t.length >= 12);
}

/**
 * Что мы знаем о модели: тариф и принимает ли она параметры сэмплирования.
 *
 * Заведено при переходе с Astra на Fable 5.1 (решение владельца 08.09), когда
 * выяснилось, что смена одного идентификатора ломает прогон дважды:
 *
 *   1. `temperature` у семейства Claude 4.6+ СНЯТА и даёт 400 — запрос упал бы
 *      сразу, и в обоих местах: и в проходе, и в круге проверки;
 *   2. цена считалась константой Astra с подписью «прайс Astra из каталога».
 *      Под другой моделью это печатало бы уверенное НЕВЕРНОЕ число — то самое
 *      «обязательное поле заполняется выдумкой» из §4.0.
 *
 * Поэтому у тарифа есть исход «не знаю»: неизвестной модели цена не
 * приписывается, а говорится, что тариф не записан.
 */
interface ModelProfile {
  /** Доллары за миллион токенов; null — тариф не записан, выдумывать нельзя. */
  usdPerMTokIn: number | null;
  usdPerMTokOut: number | null;
  /** Принимает ли `temperature`. У Claude 4.6+ снята: 400. */
  sampling: boolean;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  // Anthropic напрямую — голое имя модели. Сэмплирование у этого поколения
  // снято (400), поэтому sampling: false.
  'claude-fable-5-1': { usdPerMTokIn: 10, usdPerMTokOut: 50, sampling: false },
  // Тариф из каталога поставщика; через OpenRouter возможна своя наценка,
  // поэтому число названо ОЦЕНКОЙ и здесь, и в выводе.
  'openai/gpt-6-astra': { usdPerMTokIn: 10, usdPerMTokOut: 50, sampling: true },
  'anthropic/claude-fable-5-1': { usdPerMTokIn: 10, usdPerMTokOut: 50, sampling: false },
};

/**
 * Профиль модели. Неизвестной — честное «не знаю» про цену.
 *
 * Про сэмплирование умолчание разное по семействам, и это не придирка: у
 * Claude 4.6+ `temperature` снята целиком, поэтому для `anthropic/` умолчание
 * «не слать». Для прочих сохраняется нынешнее поведение — оно работает.
 */
function modelProfile(model: string): ModelProfile {
  const known = MODEL_PROFILES[model];
  if (known) return known;
  return {
    usdPerMTokIn: null,
    usdPerMTokOut: null,
    sampling: !model.startsWith('anthropic/'),
  };
}

/**
 * Журнал разобранного: что уже смотрели и чем кончилось.
 *
 * Владелец 08.09: «аудит не должен по второму разу проверять одно и то же».
 * И правда: прогоны 2, 3 и 4 находили одни и те же дефекты разными словами,
 * и круг проверки тратился на уже известное вместо нового.
 *
 * ── Почему журнал НЕ ГЛУШИТ находки ───────────────────────────────────────
 *
 * Совпадение по файлам — догадка о тождестве, а не доказательство. В одном
 * файле живут и разобранный дефект, и новый: `rescue-agency.ts` за три
 * прогона дал и «активные теряются за LIMIT», и «выдуманное нулевое среднее
 * время реагирования» — разные вещи в одном месте. Глушить по такой догадке
 * значило бы прятать регрессию ровно там, где её уже один раз чинили.
 *
 * Поэтому журнал меняет ПОРЯДОК, а не истину: совпавшая находка помечается
 * «возможно уже разобрано», уходит в конец очереди проверки и получает
 * бюджет последней. Новому материалу — первым.
 */
interface JournalEntry {
  files?: string[];
  what?: string;
  decision?: string;
  date?: string;
  note?: string;
}

const JOURNAL_PATH = '.github/audit-journal.json';

function readJournal(): JournalEntry[] {
  try {
    const raw = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { resolved?: JournalEntry[] };
    return Array.isArray(raw.resolved) ? raw.resolved : [];
  } catch (err) {
    // Журнала может не быть — это не ошибка. Но и молчать нельзя: без него
    // аудит будет предлагать разобранное, и человек не поймёт почему.
    console.log(`журнал разобранного не прочитан (${JOURNAL_PATH}):`,
      err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Запись журнала, чьи файлы пересекаются с находкой. `null` — пересечений нет. */
export function journalOverlap(
  files: string[] | undefined,
  journal: JournalEntry[],
): JournalEntry | null {
  const mine = new Set(files ?? []);
  if (mine.size === 0) return null;
  for (const e of journal) {
    // CLAUDE.md стоит почти в каждой находке и пересекается со всем подряд —
    // по нему тождество не судим, иначе «уже разобрано» будет у всего.
    const theirs = (e.files ?? []).filter((f) => f !== 'CLAUDE.md' && f !== 'AGENTS.md');
    if (theirs.some((f) => mine.has(f))) return e;
  }
  return null;
}

/** Что сказать модели про уже разобранное, чтобы она не несла это снова. */
function journalBlock(journal: JournalEntry[]): string {
  if (journal.length === 0) return '';
  const lines = journal.map((e) =>
    `- ${(e.files ?? []).join(', ')}: ${e.what ?? ''} — ${e.decision ?? 'решение не записано'}`
    + (e.note ? ` (${e.note})` : ''));
  return '\n\nУЖЕ РАЗОБРАНО РАНЬШЕ — не повторяй, если код не разошёлся с записью.\n'
    + 'Если по этому месту у тебя НОВОЕ наблюдение, а не то же самое, скажи прямо, чем оно отличается.\n'
    + lines.join('\n');
}

/** Нашлась ли хоть одна улика в текстах названных файлов. */
export function evidenceIsQuoted(evidence: string, texts: string[]): boolean {
  const frags = evidenceFragments(evidence);
  if (frags.length === 0) return false;
  const haystacks = texts.map(squash);
  return frags.some((f) => haystacks.some((h) => h.includes(f)));
}

/**
 * Куда положить находки основного прохода и откуда их взять для проверки.
 *
 * ── Зачем разделять ───────────────────────────────────────────────────────
 *
 * Четыре прогона подряд кончились одинаково: основной проход стоит ~751 ₽ и
 * съедает баланс целиком, после чего круг проверки получает 402 на ПЕРВОЙ же
 * находке. Прогон 4 это показал начисто — дешёвый проверяющий
 * (`deepseek/deepseek-chat`) был выбран правильно и не получил ни одного
 * шанса: денег не осталось.
 *
 * Пока проход и проверка неразделимы, доплата не добивает список, а покупает
 * НОВЫЙ проход: находки живут только внутри одного запуска и умирают вместе с
 * ним. Отсюда разделение: проход сохраняет находки файлом, проверка умеет
 * работать по сохранённому — без модели, без набора, без 751 ₽.
 */
const FINDINGS_OUT = process.env.AUDIT_FINDINGS_OUT?.trim() || 'audit-findings.json';
const FINDINGS_IN = process.env.AUDIT_FINDINGS_IN?.trim() || '';

/**
 * Проверить находки, сохранённые прошлым прогоном, — без модели и без набора.
 *
 * Тексты файлов берутся из checkout'а (`readIfExists` внутри `verifyFinding`),
 * поэтому сохранять их вместе с находками не нужно: репозиторий и есть набор.
 * Единственное условие — проверять по тому же коммиту, на котором проход
 * находки и получил; иначе улика может не найтись не потому, что выдумана, а
 * потому, что файл с тех пор изменился.
 */
async function verifyOnly(key: string, path: string): Promise<void> {
  let saved: { commit?: string; good?: Finding[]; invented?: number; unquoted?: number };
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`Сохранённые находки не прочитаны (${path}):`,
      err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const good = Array.isArray(saved.good) ? saved.good : [];
  if (good.length === 0) {
    console.error('В сохранённом файле нет находок — проверять нечего. Это отказ, а не «всё чисто».');
    process.exit(1);
  }
  console.log(`проверяю сохранённые находки: ${good.length} из ${path}`);
  const now = process.env.GITHUB_SHA ?? null;
  if (saved.commit) console.log(`проход был на коммите ${saved.commit}`);
  if (saved.commit && now && saved.commit !== now) {
    // Расхождение коммитов НЕ ошибка, но и не пустяк: улика может не найтись
    // оттого, что файл с тех пор изменился, а выглядеть это будет как
    // «выдумала». Пусть человек видит это до того, как поверит исходу.
    console.log(`ВНИМАНИЕ: проверка идёт на ДРУГОМ коммите (${now}).`
      + ` Не найденная улика здесь может значить «файл изменился», а не «выдумана».`);
  }
  const model = process.argv[2] || 'openai/gpt-6-astra';
  await verifyAndReport(key, model, good, new Map(), {
    invented: saved.invented ?? 0,
    unquoted: saved.unquoted ?? 0,
  });
}



/**
 * Разбор ответа модели — ОДИН на оба пути (Anthropic напрямую и OpenRouter).
 *
 * Пути к модели разные, а правила к её ответу одни: путь вне выданного набора
 * — выдумка, утверждение без дословной улики — пересказ по памяти, находки
 * сохраняются до круга проверки. Держать это в двух местах значило бы завести
 * два разных аудита (§12).
 */
async function handleAnswer(
  key: string,
  model: string,
  text: string,
  known: Set<string>,
  files: Array<{ path: string; text: string }>,
): Promise<void> {
  const journal = readJournal();
  const { findings, note, error } = parseFindings(text);
  if (note) console.log(`ВНИМАНИЕ: ${note}`);
  if (error) {
    console.error('Разбор ответа не удался:', error);
    console.error(text.slice(0, 1200));
    process.exit(1);
  }

  // Детерминированная проверка: путь вне набора — признак выдумки.
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const good: Finding[] = [];
  let invented = 0;
  let unquoted = 0;
  for (const f of findings) {
    const paths = Array.isArray(f.files) ? f.files : [];
    const real = paths.filter((p) => known.has(p));
    if (real.length === 0 || real.length !== paths.length) { invented += 1; continue; }
    // Путь настоящий — этого мало: утверждение о содержимом может быть
    // пересказом по памяти. Улика обязана найтись в файле дословно.
    const texts = real.map((p) => byPath.get(p) ?? '');
    if (!f.evidence || !evidenceIsQuoted(f.evidence, texts)) { unquoted += 1; continue; }
    good.push({ ...f, files: real });
  }

  // Находки сохраняем ДО проверки и независимо от её исхода: проход уже
  // оплачен, и терять его результат оттого, что на проверку не хватило
  // денег, — ровно та потеря, из-за которой этот режим и заведён.
  try {
    writeFileSync(FINDINGS_OUT, JSON.stringify({
      commit: process.env.GITHUB_SHA ?? null,
      model,
      good,
      invented,
      unquoted,
    }, null, 2));
    console.log(`находки сохранены: ${FINDINGS_OUT} (${good.length})`);
  } catch (err) {
    // Не смогли сохранить — говорим вслух: иначе проверка «по сохранённому»
    // потом не найдёт файла и это будет выглядеть как «находок не было».
    console.error('Находки не сохранены:', err instanceof Error ? err.message : String(err));
  }

  await verifyAndReport(key, model, good, byPath, { invented, unquoted }, journal);
}

// ── Проход через Anthropic напрямую ──────────────────────────────────────────
//
// Прогон 5 (08.09) сгорел впустую на 1324 ₽ и научил трём вещам сразу.
//
// 1. ПОТОЛОК ВЫХОДА БЫЛ ЗАНИЖЕН. Ответ пришёл ровно на 32000 токенов — в
//    точности наш `max_tokens` — и с ПУСТЫМ полем содержимого. У этого
//    поколения моделей рассуждение включено всегда и считается в тот же
//    бюджет выхода; 32000 ушли на него, и до ответа очередь не дошла.
//    Модель держит до 128K выхода, но такой потолок требует streaming —
//    иначе запрос упирается в HTTP-таймаут раньше, чем в лимит.
//
// 2. ГЛУБИНА ДУМАНИЯ ЗАДАЁТСЯ НЕ БЮДЖЕТОМ ТОКЕНОВ, А `effort`. Попытка
//    выставить бюджет вернула бы 400: параметр снят у этого поколения.
//
// 3. РАННЕР НЕ СМОГ НАЗВАТЬ ПРИЧИНУ СОБСТВЕННОГО ОТКАЗА. Он напечатал
//    «Ответ без содержимого» и вышел — ни `stop_reason`, ни разбивки токенов.
//    Это ровно тот дефект, который аудит находит у других: третий исход есть,
//    а имени у него нет.
//
// Отсюда смета ДО траты: `count_tokens` не запускает модель, поэтому точный
// размер входа и потолок цены известны заранее. Не влезли в бюджет — не
// начинаем. Дешёвая проба формы запроса идёт перед дорогим проходом: 400 на
// незнакомом параметре стоит копейки, а вот успешный пустой ответ — тысячу
// рублей.
// Потолок выхода. Модель держит до 128K; берём 96000 и вот почему.
//
// Платим мы за ФАКТИЧЕСКИ сгенерированные токены, а не за потолок, — значит
// запас сам по себе ничего не стоит. Стоит он только через смету: она считает
// худший случай, и слишком высокий потолок упёрся бы в бюджет и отказал бы
// зря. 96000 при входе ~820 тыс. даёт худший случай около $13 — влезает в
// бюджет и оставляет рассуждению втрое больше места, чем ему не хватило в
// прогоне 5.
const ANTHROPIC_MAX_OUTPUT = 96000;

interface PassResult {
  text: string | null;
  inTok: number | null;
  outTok: number | null;
}

/** Модель Anthropic зовётся голым именем; через OpenRouter — с поставщиком. */
function isAnthropicDirect(model: string): boolean {
  return !model.includes('/');
}

function usdOf(model: string, inTok: number, outTok: number): number | null {
  const p = modelProfile(model);
  if (p.usdPerMTokIn === null || p.usdPerMTokOut === null) return null;
  return (inTok * p.usdPerMTokIn + outTok * p.usdPerMTokOut) / 1e6;
}

async function runAnthropicPass(model: string, payload: string): Promise<PassResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY не задан — проход через Anthropic невозможен.');
    process.exit(1);
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  // Тип берём у SDK, а не переописываем: своя копия разошлась бы с ним молча.
  const messages: import('@anthropic-ai/sdk').Anthropic.MessageParam[] = [
    { role: 'user', content: payload },
  ];

  // ── Смета до траты ────────────────────────────────────────────────────────
  let inTokPlanned: number;
  try {
    const counted = await client.messages.countTokens({ model, system: SYSTEM, messages });
    inTokPlanned = counted.input_tokens;
  } catch (err) {
    console.error('Смету посчитать не удалось:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const worstUsd = usdOf(model, inTokPlanned, ANTHROPIC_MAX_OUTPUT);
  console.log(`смета: вход ${inTokPlanned} токенов, потолок выхода ${ANTHROPIC_MAX_OUTPUT}`);
  if (worstUsd !== null) {
    console.log(`потолок цены прохода: $${worstUsd.toFixed(2)} (~${(worstUsd * RUB_PER_USD).toFixed(0)} ₽)`);
  }
  const budget = Number(process.env.AUDIT_BUDGET_USD ?? '');
  if (Number.isFinite(budget) && worstUsd !== null && worstUsd > budget) {
    console.error(
      `ОТКАЗ ДО ТРАТЫ: потолок $${worstUsd.toFixed(2)} больше бюджета $${budget.toFixed(2)}. ` +
      'Сузить набор (targets) или поднять бюджет — но не платить вслепую.',
    );
    process.exit(1);
  }

  // ── Дешёвая проба формы ───────────────────────────────────────────────────
  // Те же параметры, крошечный вход. Если форма запроса неверна — узнаём это
  // за копейки, а не за тысячу рублей.
  try {
    const probe = await client.messages.create({
      model,
      max_tokens: 64,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Ответь одним словом: готов' }],
    });
    const probeText = probe.content.find((b) => b.type === 'text');
    if (!probeText) {
      console.error(
        `ПРОБА НЕ ДАЛА ТЕКСТА (stop_reason=${probe.stop_reason}). Дорогой проход не начинаем.`,
      );
      process.exit(1);
    }
    console.log(`проба формы: ответ есть (${probe.usage.output_tokens} токенов выхода)`);
  } catch (err) {
    console.error('ПРОБА УПАЛА:', err instanceof Error ? err.message : String(err));
    console.error('Дорогой проход не начинаем — сначала чиним форму запроса.');
    process.exit(1);
  }

  // ── Сам проход ────────────────────────────────────────────────────────────
  // Streaming обязателен при таком потолке выхода. `thinking` не шлём вовсе:
  // у этого поколения оно включено всегда, а любая явная настройка — 400.
  const stream = client.messages.stream({
    model,
    max_tokens: ANTHROPIC_MAX_OUTPUT,
    output_config: { effort: 'high' },
    system: SYSTEM,
    messages,
  });
  const msg = await stream.finalMessage();

  const inTok = msg.usage.input_tokens;
  const outTok = msg.usage.output_tokens;
  const textBlocks = msg.content.filter((b) => b.type === 'text');
  const thinkingBlocks = msg.content.filter((b) => b.type === 'thinking');
  const text = textBlocks.map((b) => (b as { text: string }).text).join('').trim() || null;

  // Разбор отказа — поимённо. Именно этого не хватило 08.09.
  console.log(
    `остановка: ${msg.stop_reason}` +
    ` · блоков текста ${textBlocks.length}, блоков рассуждения ${thinkingBlocks.length}`,
  );
  if (msg.stop_reason === 'refusal') {
    console.error(`МОДЕЛЬ ОТКАЗАЛАСЬ отвечать (категория: ${msg.stop_details?.category ?? 'не названа'}).`);
  }
  if (msg.stop_reason === 'max_tokens' && text === null) {
    console.error(
      `ОТВЕТ НЕ УМЕСТИЛСЯ: весь бюджет выхода (${outTok}) ушёл на рассуждение, текста не осталось. ` +
      'Поднять ANTHROPIC_MAX_OUTPUT или понизить effort — но НЕ повторять как есть.',
    );
  }
  return { text, inTok, outTok };
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('OPENROUTER_API_KEY не задан — спросить некого.'); process.exit(1); }
  const model = process.argv[2] || 'openai/gpt-6-astra';
  const targets = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_TARGETS;

  if (FINDINGS_IN) {
    await verifyOnly(key, FINDINGS_IN);
    return;
  }

  const { files, skipped, bytes } = collect(targets);
  if (files.length === 0) {
    console.error('Набор пуст — читать нечего. Это отказ, а не «нарушений нет».');
    process.exit(1);
  }
  console.log(`набор: ${files.length} файлов, ${(bytes / 1024).toFixed(0)} КБ` + (skipped ? ` (не вместилось: ${skipped})` : ''));
  console.log(`модель: ${model}`);

  const known = new Set(files.map((f) => f.path));
  const journal = readJournal();
  if (journal.length > 0) console.log(`уже разобрано раньше: ${journal.length} записей — не повторяем`);
  const payload = files.map((f) => `=== ФАЙЛ: ${f.path} ===\n${f.text}`).join('\n\n')
    + journalBlock(journal);

  const started = Date.now();

  // Развилка поставщика. Голое имя модели — Anthropic напрямую: там есть
  // смета до траты, streaming и внятный stop_reason. Имя с поставщиком —
  // OpenRouter, как было.
  if (isAnthropicDirect(model)) {
    const pass = await runAnthropicPass(model, payload);
    console.log(
      `ответ за ${((Date.now() - started) / 1000).toFixed(1)} с, ` +
      `токенов: вход ${pass.inTok ?? '?'} / выход ${pass.outTok ?? '?'}`,
    );
    const usd = pass.inTok !== null && pass.outTok !== null
      ? usdOf(model, pass.inTok, pass.outTok) : null;
    if (usd !== null) {
      console.log(`цена прохода: $${usd.toFixed(3)} (~${(usd * RUB_PER_USD).toFixed(0)} ₽, оценка по §8)`);
    } else {
      console.log(`цена прохода не посчитана: тариф модели ${model} не записан в MODEL_PROFILES`);
    }
    if (!pass.text) { console.error('Ответ без содержимого — причина названа выше.'); process.exit(1); }
    await handleAnswer(key, model, pass.text, known, files);
    return;
  }

  let res: Response;
  try {
    res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${key}`, ...openRouterAttribution('os audit') },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: payload }],
        max_tokens: 32000,
        // `temperature` шлём только тем, кто её принимает: у Claude 4.6+ она
        // снята и даёт 400 — прогон упал бы, не начавшись.
        ...(modelProfile(model).sampling ? { temperature: 0.2 } : {}),
      }),
      signal: AbortSignal.timeout(900_000),
    });
  } catch (err) {
    console.error('Модель не ответила:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`); process.exit(1); }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? null;
  const inTok = data.usage?.prompt_tokens ?? null;
  const outTok = data.usage?.completion_tokens ?? null;
  console.log(`ответ за ${((Date.now() - started) / 1000).toFixed(1)} с, токенов: вход ${inTok ?? '?'} / выход ${outTok ?? '?'}`);
  const price = modelProfile(model);
  if (inTok !== null && outTok !== null && price.usdPerMTokIn !== null && price.usdPerMTokOut !== null) {
    const usd = (inTok * price.usdPerMTokIn + outTok * price.usdPerMTokOut) / 1e6;
    console.log(`цена прохода: $${usd.toFixed(3)} (~${(usd * RUB_PER_USD).toFixed(0)} ₽, оценка по §8)`);
  } else {
    // Тариф не записан — молчать нельзя, но и выдумывать нечего.
    console.log(`цена прохода не посчитана: тариф модели ${model} не записан в MODEL_PROFILES`);
  }
  if (!text) { console.error('Ответ без содержимого.'); process.exit(1); }

  await handleAnswer(key, model, text, known, files);
}

/**
 * Круг проверки и печать итога — общие для обоих способов запуска.
 *
 * Вызывается и после основного прохода, и в режиме «проверить сохранённое»
 * (`AUDIT_FINDINGS_IN`). Второй способ нужен потому, что проход и проверка
 * стоят разных денег и в один баланс не помещаются: см. FINDINGS_OUT.
 */
async function verifyAndReport(
  key: string,
  model: string,
  good: Finding[],
  byPath: Map<string, string>,
  counts: { invented: number; unquoted: number },
  journal: JournalEntry[] = [],
): Promise<void> {
  const { invented, unquoted } = counts;

  // Предложения усиления проверке «подтверждено / опровергнуто» НЕ подлежат.
  //
  // Проверяющий отвечает на вопрос «есть ли названное в файле». Для дефекта
  // это и есть суть. Для предложения — нет: там утверждается, чего НЕТ, и
  // «не нашёл» не значит ни «верно», ни «неверно». Прогонять их тем же
  // рубрикатором значило бы тратить бюджет и получать исход, который ничего
  // не решает. Предложения печатаются отдельно, вместе с уликой, и их
  // взвешивает человек.
  const proposals = good.filter((f) => f.kind === 'strengthening');
  const defects = good.filter((f) => f.kind !== 'strengthening');

  // Очередь проверки: сначала НОВОЕ, потом пересекающееся с разобранным.
  // Порядок решает, кому достанется бюджет, если он кончится на середине.
  const overlap = new Map<Finding, JournalEntry | null>();
  for (const f of defects) overlap.set(f, journalOverlap(f.files, journal));
  const fresh = defects.filter((f) => overlap.get(f) === null);
  const seen = defects.filter((f) => overlap.get(f) !== null);
  if (seen.length > 0) {
    console.log(`\nв конец очереди проверки: ${seen.length} находок пересекаются с уже разобранным`
      + ' (не отброшены — совпадение по файлу не доказывает тождества)');
  }
  good = [...fresh, ...seen];
  // Второй заход: каждую находку перепроверяем отдельно, показывая только её
  // файлы. Первый ответ модели поверхностен — это правило, а не случай.
  //
  // Модель проверки — СВОЯ и по умолчанию дешевле основной.
  //
  // Два прогона подряд (2 и 3, ~1500 ₽) кончились одинаково: основной проход
  // съедал баланс, а круг проверки упирался в 402, и тринадцать находок из
  // девятнадцати оставались с исходом «не смог». Платить третий раз значило
  // бы перетасовать список, а не добить его: проверка идёт по порядку, пока
  // есть деньги, и какие находки успеют — дело очереди.
  //
  // Задача проверки узкая: дан текст файлов и одно утверждение, надо найти
  // дословную примету и выбрать один из трёх исходов. Флагман здесь не нужен;
  // к тому же ОТДЕЛЬНЫЙ судья независимее того же самого, что находку и
  // написал. Ошибка дешёвой модели в сторону `cannot_tell` безопасна — это
  // третий исход, а не ложное подтверждение.
  const verifyModel = process.env.AUDIT_VERIFY_MODEL?.trim() || model;
  console.log(`\nперепроверяю каждую находку отдельным заходом (${good.length}), модель: ${verifyModel}`);
  const checked: Array<Finding & { verdict: string; why: string; missing: string; rounds: number }> = [];
  let escalated = 0;
  let outOfFunds = false;
  for (const f of good) {
    if (outOfFunds) {
      // Денег нет — дальше не ходим. Молча пропустить нельзя, поэтому исход
      // называется своими словами, а не общим «HTTP 402».
      checked.push({
        ...f,
        verdict: 'cannot_tell',
        why: 'до этой находки проверка не дошла: на круге проверки кончился баланс',
        missing: '',
        rounds: 0,
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    let v = await verifyFinding(key, verifyModel, f, byPath);
    if (v.outOfFunds) outOfFunds = true;
    let rounds = 1;

    // ── Третий круг: только с НОВЫМ материалом ─────────────────────────────
    //
    // Владелец 08.09: «иногда даже 3 ответ поверхностен, но это зависит от
    // уточняющих вопросов». Повторить тот же вопрос — получить тот же
    // поверхностный ответ; круг имеет смысл, лишь когда приносит то, чего в
    // прошлый раз не было.
    //
    // Поэтому эскалация не по счётчику, а по УЛОВИЮ: второй круг сказал
    // «не смог» И назвал недостающие файлы, И они существуют. Иначе
    // «не смог» остаётся честным исходом, а не поводом спрашивать снова.
    if (v.verdict === 'cannot_tell' && v.missing) {
      const extra = namedFiles(v.missing).filter((p) => !(f.files ?? []).includes(p));
      if (extra.length > 0) {
        escalated += 1;
        // eslint-disable-next-line no-await-in-loop
        const again = await verifyFinding(key, verifyModel, f, byPath, extra);
        rounds = 2;
        v = { ...again, why: `${again.why} [с добавленными: ${extra.join(', ')}]` };
      }
    }
    checked.push({ ...f, ...v, rounds });
  }
  const confirmed = checked.filter((f) => f.verdict === 'confirmed');
  const refuted = checked.filter((f) => f.verdict === 'refuted').length;
  const unclear = checked.filter((f) => f.verdict === 'cannot_tell');

  const rank = (s?: string) => (s === 'high' ? 0 : s === 'medium' ? 1 : 2);
  confirmed.sort((a, b) => rank(a.severity) - rank(b.severity));

  console.log(`\nпосле детерминированной проверки: ${defects.length} находок · ${proposals.length} предложений усиления`
    + ` · ${invented} с путями вне набора · ${unquoted} без дословной улики в названном файле\n`);
  console.log(`после перепроверки: подтверждено ${confirmed.length}`
    + ` · опровергнуто ${refuted} · не удалось проверить ${unclear.length}`
    + ` (второй круг с новыми файлами: ${escalated})\n`);
  if (outOfFunds) {
    // «Не смог по существу» и «не хватило денег» — разные вещи, и слитые в
    // одно они врут дважды: скрывают причину и выдают недосмотренное за
    // досмотренное. Пусть это будет видно ОТДЕЛЬНОЙ строкой.
    const notReached = checked.filter((f) => f.rounds === 0).length;
    console.log(`ВНИМАНИЕ: на круге проверки кончился баланс OpenRouter.`
      + ` До ${notReached} находок проверка не дошла вовсе — это не «неверно»`
      + ` и не «проверено». Повторный полный прогон список не добьёт, а`
      + ` перетасует: дешевле поставить AUDIT_VERIFY_MODEL.\n`);
  }

  for (const f of confirmed) {
    console.log('---');
    console.log(` [${f.severity ?? 'без важности'}] ${f.kind ?? 'род не назван'}`);
    for (const p of f.files ?? []) console.log(`   • ${p}`);
    console.log(` суть: ${f.what ?? '(не сказано)'}`);
    console.log(` улика: ${f.evidence ?? '(не приведена)'}`);
    console.log(` проверка: ${f.why}`);
    console.log(` предложение: ${f.proposal ?? '(нет)'}`);
    const was = journalOverlap(f.files, journal);
    if (was) {
      console.log(` ВНИМАНИЕ: по этим файлам уже было решение (${was.decision ?? 'без решения'},`
        + ` ${was.date ?? 'без даты'}): ${was.what ?? ''}.`
        + ' Либо это ДРУГОЙ дефект, либо починка не удержалась — разобрать глазами.');
    }
  }

  // ── Предложения усиления ───────────────────────────────────────────────
  //
  // Отдельным разделом и без вердикта: здесь не «правда или ложь», а «стоит
  // или не стоит», и это решает человек. Улика приводится, чтобы было видно,
  // от чего предложение отталкивается, — предложение без опоры в коде ничем
  // не лучше выдумки и отсеивается тем же ситом.
  if (proposals.length > 0) {
    console.log(`\n\nПРЕДЛОЖЕНИЯ УСИЛЕНИЯ (${proposals.length}) — не дефекты; проверке`
      + ' «подтверждено/опровергнуто» не подлежат, потому что утверждают то, чего ещё НЕТ:');
    const rankP = (x?: string) => (x === 'high' ? 0 : x === 'medium' ? 1 : 2);
    for (const f of [...proposals].sort((a, b) => rankP(a.severity) - rankP(b.severity))) {
      console.log('---');
      console.log(` [${f.severity ?? 'без важности'}] усиление`);
      for (const p of f.files ?? []) console.log(`   • ${p}`);
      console.log(` суть: ${f.what ?? '(не сказано)'}`);
      console.log(` от чего отталкиваемся: ${f.evidence ?? '(улика не приведена)'}`);
      console.log(` что сделать: ${f.proposal ?? '(нет)'}`);
    }
  }

  // «Не смог проверить» не прячем: это третий исход, а не отсутствие находки.
  if (unclear.length > 0) {
    console.log(`\nНЕ УДАЛОСЬ ПРОВЕРИТЬ (${unclear.length}) — судить по выданному нельзя, не значит «неверно»:`);
    for (const f of unclear) {
      console.log(`  • ${f.what ?? '(без сути)'} — ${f.why}`);
      // Названное недостающее — это заявка на следующий замер, а не шум.
      if (f.missing) console.log(`    не хватило: ${f.missing}`);
    }
  }

  if (confirmed.length === 0 && defects.length > 0) {
    console.error('\nНи одной ПОДТВЕРЖДЁННОЙ находки при непустом списке. «Всё чисто» и «модель не справилась» неразличимы — прогон красный.');
    process.exit(1);
  }
  if (confirmed.length === 0 && defects.length === 0 && proposals.length === 0) {
    console.error('\nНи находок, ни предложений. Это отказ разбора, а не «платформа безупречна».');
    process.exit(1);
  }
  console.log('\nНичего не изменено: аудит только читает. Решает человек.');
}



// Запускаемся только когда нас ПОЗВАЛИ. Сторож импортирует отсюда чистые
// функции проверки улик, и без этого условия сам импорт запускал бы аудит:
// проверка кода превращалась бы в вызов модели за деньги.
const calledDirectly = (process.argv[1] ?? '').includes('os-audit-runner');
if (calledDirectly) void main();
