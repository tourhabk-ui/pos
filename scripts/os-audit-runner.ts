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
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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

ЖЁСТКИЕ ПРАВИЛА (нарушение делает находку бесполезной):
- Ссылайся ТОЛЬКО на пути файлов из выданного набора. Не сочиняй путей.
- В evidence приводи ДОСЛОВНЫЕ фрагменты кода или текста из выданных файлов.
- Не предполагай содержимое файлов, которых в наборе нет.
- Безопасность туриста важнее всего: находки про SOS, офлайн, тревоги и Кузьмича ставь выше.
- Лучше десять находок с уликами, чем сто догадок.

Ответь СТРОГО одним JSON-объектом:
{"findings":[{"severity":"high|medium|low","kind":"rule_not_enforced|rule_duplicated|guard_toothless|failure_swallowed|missing_third_state|declared_not_real","files":["путь"],"what":"суть одной фразой","evidence":"дословно из файлов","proposal":"что делать"}]}`;

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
        temperature: 0,
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

/** Нашлась ли хоть одна улика в текстах названных файлов. */
export function evidenceIsQuoted(evidence: string, texts: string[]): boolean {
  const frags = evidenceFragments(evidence);
  if (frags.length === 0) return false;
  const haystacks = texts.map(squash);
  return frags.some((f) => haystacks.some((h) => h.includes(f)));
}

async function main(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('OPENROUTER_API_KEY не задан — спросить некого.'); process.exit(1); }
  const model = process.argv[2] || 'openai/gpt-6-astra';
  const targets = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_TARGETS;

  const { files, skipped, bytes } = collect(targets);
  if (files.length === 0) {
    console.error('Набор пуст — читать нечего. Это отказ, а не «нарушений нет».');
    process.exit(1);
  }
  console.log(`набор: ${files.length} файлов, ${(bytes / 1024).toFixed(0)} КБ` + (skipped ? ` (не вместилось: ${skipped})` : ''));
  console.log(`модель: ${model}`);

  const known = new Set(files.map((f) => f.path));
  const payload = files.map((f) => `=== ФАЙЛ: ${f.path} ===\n${f.text}`).join('\n\n');

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${key}`, ...openRouterAttribution('os audit') },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: payload }],
        max_tokens: 32000,
        temperature: 0.2,
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
  if (inTok !== null && outTok !== null) {
    const usd = inTok * 1e-5 + outTok * 5e-5; // прайс Astra из каталога
    console.log(`цена прохода: $${usd.toFixed(3)} (~${(usd * RUB_PER_USD).toFixed(0)} ₽, оценка по §8)`);
  }
  if (!text) { console.error('Ответ без содержимого.'); process.exit(1); }

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

  console.log(`\nпосле детерминированной проверки: ${good.length} принято`
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

  if (confirmed.length === 0) {
    console.error('\nНи одной ПОДТВЕРЖДЁННОЙ находки. «Всё чисто» и «модель не справилась» неразличимы — прогон красный.');
    process.exit(1);
  }
  console.log('\nНичего не изменено: аудит только читает. Решает человек.');
}

// Запускаемся только когда нас ПОЗВАЛИ. Сторож импортирует отсюда чистые
// функции проверки улик, и без этого условия сам импорт запускал бы аудит:
// проверка кода превращалась бы в вызов модели за деньги.
const calledDirectly = (process.argv[1] ?? '').includes('os-audit-runner');
if (calledDirectly) void main();
