/**
 * lib/agents/eval/commercial-checks.ts
 *
 * Коммерческий эвал Кузьмича: судит ответ про туры по свойствам, которые
 * можно проверить без модели-судьи и без цифр, зашитых в фикстуру.
 *
 * ── Зачем (разбор «мозг Кузьмича при росте каталога», шаг 1, 29.10) ─────────
 *
 * В фикстуре faithfulness-эвала было двадцать вопросов — безопасность,
 * маршруты, сезон, логистика — и ни одного про туры. Каталог за октябрь вырос
 * с восьми туров до семидесяти пяти, и сравнивать модели и устройство памяти
 * под этот рост было не на чем: «стало лучше» звучало бы как факт о Кузьмиче,
 * будучи фактом о нашем выборе вопросов.
 *
 * ── Эталон — критерий, а не цифры ──────────────────────────────────────────
 *
 * Цена или список туров, записанные в фикстуру, устарели бы при первой правке
 * оператора, и эвал начал бы штрафовать Кузьмича за верный ответ. Поэтому в
 * фикстуре стоит только КРИТЕРИЙ («назвать все туры, которые инструмент отдаёт
 * по слову «Толбачик»»), а эталон берётся в момент прогона — тем же
 * инструментом get_tours, которым пользуется сам Кузьмич (как в фактическом
 * экзамене, lib/kuzmich/fact-exam-cases.ts).
 *
 * ── Три исхода у каждой проверки (§4.0) ───────────────────────────────────
 *
 * `unknown` — «не смог проверить»: инструмент эталона отказал, эталон пуст
 * (вопрос фикстуры устарел), в ответе не узнан ни один тур. Это не `pass`.
 *
 * ── Пределы, названные вслух ──────────────────────────────────────────────
 *
 *  - Эталон — вывод того же get_tours, которым пользуется Кузьмич. Тур,
 *    которого инструмент не находит по слову (например, связанный с местом
 *    только через operator_tours.main_place_id, без слова места в тексте),
 *    эвал не видит тоже: «все туры к месту» здесь значит «все, что нашёл
 *    инструмент». Пробел инструмента фиксирует pg-тест
 *    tests/integration/public-tour-gate.pg.test.ts (KNOWN_INCOMPLETE).
 *  - Тур «назван», если в ответе стоит его название (без кавычек и регистра)
 *    либо его цена, которая среди известных туров принадлежит ему одному.
 *    Пересказ названия без единственной цены не узнаётся — проверка «назвал
 *    все» в этом случае строже правды, а «компания у каждого тура» — мягче.
 *  - Цена считается ценой, только если при числе стоит ₽/руб/тыс или «к»
 *    слитно с числом («50к»). «в 6 к Толбачику» — предлог, не тысячи. Первое
 *    число диапазона без единицы («60–115 тыс.») не проверяется.
 *  - Цена «из данных», если она есть в данных хода, в каталоге витрины на
 *    момент прогона или в самом вопросе (бюджет туриста), либо равна такой
 *    цене, умноженной на число людей ИЗ ВОПРОСА («на двоих» — ×2). Без числа
 *    людей в вопросе кратные не принимаются: иначе при цене 5 000 в каталоге
 *    проходила бы любая круглая выдумка. Чужую цену, верную для другого тура,
 *    эта проверка не ловит: принадлежность цены туру — не её предмет.
 *  - Бюджет сравнивается только с ценой ЗА ЧЕЛОВЕКА. Цена за группу или за
 *    человека в день с бюджетом несравнима — такой тур в бюджетных проверках
 *    не требуется и не запрещается.
 *  - Месяц и сезон тура не судятся: в выводе инструмента сезон есть не у всех
 *    туров (у туров с расписанием — только ближайшая дата). Поэтому вопросы
 *    «вид + месяц» требуют хотя бы один тур вида, а не все (`names_some_tour`
 *    с `narrowed`), и честное «в этот месяц нет» там — «не смог», а не провал.
 *  - «Что есть у компании» требует хотя бы один её тур и ни одного чужого;
 *    полноту не требует: у компании бывает тридцать туров, а ответ в чате —
 *    выборка. С уточнением («вертолётные у Лагуны») честное «нет» — «не смог»:
 *    подмножество по виду эталоном не проверяется.
 *  - «Такого на платформе нет» сверяется с get_tours по слову вопроса: тур
 *    появился — вопрос устарел, «не смог», а не провал верного ответа.
 */
import { z } from 'zod';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';

// ── Критерии фикстуры ────────────────────────────────────────────────────────

export const CommercialCheckSchema = z.discriminatedUnion('kind', [
  /** Назвать все туры, которые get_tours отдаёт по слову (с max_price — не дороже, цена за человека). */
  z.object({ kind: z.literal('names_all_tours'), query: z.string().min(3), max_price: z.number().int().positive().optional() }),
  /**
   * Назвать хотя бы один тур из тех, что get_tours отдаёт по слову: туры
   * заведомо есть — «уточните у оператора» без единого тура — провал.
   * `narrowed` — вопрос сужает слово тем, чего эталон не проверяет (месяц,
   * вид, длительность): честное «такого нет» тогда — «не смог», а не провал.
   */
  z.object({ kind: z.literal('names_some_tour'), query: z.string().min(3), narrowed: z.boolean().optional() }),
  /** У каждого названного тура названа компания, которая его проводит. */
  z.object({ kind: z.literal('operator_for_each_tour') }),
  /** Каждая цена ответа — из данных хода, витрины или вопроса. */
  z.object({ kind: z.literal('prices_from_data') }),
  /**
   * Честное «такого на платформе нет». `query` — слово, по которому тура быть
   * не должно: get_tours по нему отдал туры — вопрос устарел («не смог»).
   */
  z.object({ kind: z.literal('says_not_on_platform'), query: z.string().min(3).optional() }),
  /**
   * Названы туры только этой компании, и хотя бы один. `narrowed` — вопрос
   * сужает (вид, место): честное «у неё такого нет» — «не смог», не провал.
   */
  z.object({ kind: z.literal('only_operator'), operator: z.string().min(3), narrowed: z.boolean().optional() }),
  /** Тур дороже бюджета назван — значит, сказано, что он дороже. */
  z.object({ kind: z.literal('over_budget_flagged'), max_price: z.number().int().positive() }),
]);
export type CommercialCheck = z.infer<typeof CommercialCheckSchema>;
export type CommercialCheckKind = CommercialCheck['kind'];

export type CheckOutcome = 'pass' | 'fail' | 'unknown';

export interface CheckVerdict {
  kind: CommercialCheckKind;
  outcome: CheckOutcome;
  /** Почему так — для записи прогона. Без текста ответа (он в отчёте рядом). */
  reason: string;
}

export interface CommercialVerdict {
  outcome: CheckOutcome;
  checks: CheckVerdict[];
}

// ── Разбор строк каталога ────────────────────────────────────────────────────

/**
 * За что назначена цена — по подписи каталога (lib/tours/labels,
 * PRICE_UNIT_SHORT): «₽/чел.», «₽/чел. в день», «₽/группа»; без подписи —
 * не записано.
 */
export type PriceUnit = 'per_person' | 'per_day_per_person' | 'per_tour' | 'unknown';

/** Строка тура в выводе get_tours и в каталоге подсказки (loadTourCatalog). */
export interface TourLine {
  id: string;
  title: string;
  operator: string | null;
  price: number | null;
  /** null — цены нет вовсе. */
  unit: PriceUnit | null;
}

function unitOf(after: string): PriceUnit {
  if (/^\/чел\.? в день/.test(after)) return 'per_day_per_person';
  if (/^\/группа/.test(after)) return 'per_tour';
  if (/^\/чел/.test(after)) return 'per_person';
  return 'unknown';
}

/** ё→е, без регистра и знаков: «Вулкан Толбачик (вертолёт)» → «вулкан толбачик вертолет». */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

const SPACE = '[ \\u00a0\\u202f]';
const NUM = `\\d{1,3}(?:${SPACE}\\d{3})+|\\d+`;
// Число, необязательная дробь, «тыс»/«к» и валюта. «к» — тысячи, только если
// стоит слитно с числом («50к») или перед валютой («50 к ₽»): «в 6 к
// Толбачику» — предлог (ревью 29.10). Буква после «к» — это слово («км»).
const PRICE_RE = new RegExp(
  `(${NUM})(?:[.,](\\d{1,2}))?(?:\\s*(тыс\\.?|тысяч[а-я]*)|(к)(?![а-яёa-z])|\\s+(к)(?=\\s*(?:₽|руб)))?\\s*(₽|руб[а-я]*\\.?|р\\.)?`,
  'giu',
);

function toNumber(intPart: string, frac: string | undefined, thousands: boolean): number {
  const base = Number(intPart.replace(/[   ]/g, '')) + (frac ? Number(`0.${frac}`) : 0);
  return Math.round(thousands ? base * 1000 : base);
}

/** Цены в тексте: только числа при ₽/руб/тыс/к. */
export function extractPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const [, intPart, frac, tys, kGlued, kSpaced, currency] = m;
    const thousands = Boolean(tys || kGlued || kSpaced);
    if (!thousands && !currency) continue;
    const n = toNumber(intPart, frac, thousands);
    if (n > 0) out.push(n);
  }
  return out;
}

/** Числа вопроса — бюджет туриста («до 50 000», «50к», «50 тысяч»), от 100. */
export function questionNumbers(question: string): number[] {
  const out: number[] = [];
  for (const m of question.matchAll(PRICE_RE)) {
    const [, intPart, frac, tys, kGlued, kSpaced] = m;
    const n = toNumber(intPart, frac, Boolean(tys || kGlued || kSpaced));
    if (n >= 100) out.push(n);
  }
  return out;
}

const TOUR_LINE_RE = /^ID(\d+): "([^"]+)"(.*)$/;

/** Строки туров из текста каталога/инструмента. Повтор id — первая запись. */
export function parseTourLines(text: string): TourLine[] {
  const seen = new Set<string>();
  const out: TourLine[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(TOUR_LINE_RE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const rest = m[3];
    const op = rest.match(/\| Оп: ([^|]+?)\s*(?:\||$)/);
    const price = rest.match(new RegExp(`от (${NUM}) ₽(\\S*(?: в день)?)`));
    out.push({
      id: m[1],
      title: m[2],
      operator: op ? op[1].trim() : null,
      price: price ? toNumber(price[1], undefined, false) : null,
      unit: price ? unitOf(price[2]) : null,
    });
  }
  return out;
}

/**
 * Эталон по слову: туры ПЕРВОЙ части ответа get_tours. Туры после пометки
 * «тип у них другой» инструмент сам велит уточнить, прежде чем предлагать, —
 * не назвать их не ошибка. Ответ «Туров «…» сейчас нет — …Весь каталог для
 * замены» — пустой эталон, а не весь каталог.
 */
export function referenceTours(toolText: string): TourLine[] {
  if (/^Туров «[^»]*» у операторов платформы сейчас нет/.test(toolText.trim())) return [];
  // Пометка в шапке («Тура с типом «X» нет. Упоминают…») — весь список и есть
  // «другой тип»: до неё туров нет, эталон пуст.
  const cut = toolText.search(/тип у них другой/);
  return parseTourLines(cut >= 0 ? toolText.slice(0, cut) : toolText);
}

/**
 * Какие туры из `universe` названы в ответе: по названию либо по цене,
 * которая в `universe` принадлежит одному туру.
 */
export function namedTours(answer: string, universe: readonly TourLine[]): TourLine[] {
  const text = ` ${normalizeText(answer)} `;
  const answerPrices = new Set(extractPrices(answer));
  const priceOwners = new Map<number, number>();
  for (const t of universe) if (t.price !== null) priceOwners.set(t.price, (priceOwners.get(t.price) ?? 0) + 1);
  return universe.filter((t) => {
    const title = normalizeText(t.title);
    if (title.length >= 6 && text.includes(` ${title} `)) return true;
    return t.price !== null && answerPrices.has(t.price) && priceOwners.get(t.price) === 1;
  });
}

// Честное «нет»: отрицание про тур, платформу, каталог — в одной части фразы.
// Не любое «нет» в тексте: «мест на июль сейчас нет» рядом с выдуманной ценой
// — не «такого тура нет» (ревью 29.10).
const NEGATION_RE = /(?:^|[^а-яё])(?:нет(?![а-яё])|не нашл|не нашёл|не нашел|не найд|не продаё|не продае|отсутству)/i;
const TOPIC_RE = /(?:^|[^а-яё])(?:тур|платформ|каталог|предложени|у операторов)/i;
const SEATS_RE = /(?:^|[^а-яё])(?:мест|места|местах|свободн)(?:[^а-яё]|$)/i;
const STANDALONE_NONE_RE = /ничего (?:не нашл|не нашёл|не нашел|не найден)|(?:^|[^а-яё])(?:такого|таких) (?:у нас )?нет/i;

/** Части ответа: фразы, а внутри — куски между запятыми, тире и точками с запятой. */
function clauses(text: string): string[] {
  return text.split(/[.!?\n;,—–]+/).map((c) => c.trim()).filter(Boolean);
}

/** Ответ честно говорит «такого на платформе нет». */
export function saysNotOnPlatform(answer: string): boolean {
  return clauses(answer).some((c) => !SEATS_RE.test(c)
    && ((NEGATION_RE.test(c) && TOPIC_RE.test(c)) || STANDALONE_NONE_RE.test(c)));
}

/**
 * Название из кавычек вопроса стоит в ответе в одной фразе с ценой — тур из
 * вопроса выдан за существующий, что бы ни стояло рядом («мест нет»).
 */
function quotedTitleWithPrice(question: string, answer: string): string | null {
  const titles = [...question.matchAll(/«([^»]{4,})»/g)].map((m) => normalizeText(m[1])).filter((t) => t.length >= 6);
  if (titles.length === 0) return null;
  for (const sentence of answer.split(/[.!?\n]+/)) {
    const norm = ` ${normalizeText(sentence)} `;
    const hit = titles.find((t) => norm.includes(` ${t} `));
    if (hit && extractPrices(sentence).length > 0) return hit;
  }
  return null;
}

/**
 * Число людей из вопроса: «на двоих», «втроём», «на 4 человек». null — не
 * названо: кратные цены тогда не принимаются вовсе.
 */
export function peopleInQuestion(question: string): number | null {
  const q = question.toLowerCase().replace(/ё/g, 'е');
  const words: Array<[RegExp, number]> = [
    [/на двоих|вдвоем/, 2], [/на троих|втроем/, 3], [/на четверых|вчетвером/, 4],
    [/на пятерых|впятером/, 5], [/на шестерых|вшестером/, 6],
  ];
  for (const [re, n] of words) if (re.test(q)) return n;
  const m = q.match(/(\d{1,2})\s*(?:человек|чел(?![а-яё])|туриста|туристов|взросл)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 2 && n <= 30 ? n : null;
}

// «Дороже бюджета»: тур выше потолка назван — так и сказано.
const OVER_BUDGET_RE = /дороже|выше бюджет|выше вашего|выше твоего|превыша|сверх бюджет|не уклад|за рамк|больше бюджет|за пределами бюджет|вне бюджет/i;

// ── Эталоны ──────────────────────────────────────────────────────────────────

/** Вызов инструмента Кузьмича: имя и аргументы → текст (как у executeKuzmichTool). */
export type ReferenceTool = (name: string, args: Record<string, string>) => Promise<string>;

export type ReferenceResult = { ok: true; text: string } | { ok: false; reason: string };

/** Ключ эталона: get_tours по слову; '' — весь каталог витрины. */
export const referenceKey = (query: string) => `get_tours:${query}`;

/** Текст отказа инструмента — тот же, что отдаёт исполнитель Кузьмича: эталон не прочитан. */
const TOOL_FAILED_TEXT = TOOL_EXECUTION_FAILED;

/**
 * Эталоны для вопроса: весь каталог витрины (цены и компании «из данных»)
 * и get_tours по каждому слову критериев. Отказ инструмента — `ok: false` с
 * причиной и строка в лог: «не смог» не выдаётся за «туров нет» (§4.0).
 */
export async function loadReferences(
  checks: readonly CommercialCheck[],
  tool: ReferenceTool,
): Promise<Map<string, ReferenceResult>> {
  const queries = new Set<string>(['']);
  for (const c of checks) {
    if (c.kind === 'names_all_tours' || c.kind === 'names_some_tour') queries.add(c.query);
    if (c.kind === 'says_not_on_platform' && c.query) queries.add(c.query);
  }
  const out = new Map<string, ReferenceResult>();
  for (const q of queries) {
    try {
      const text = await tool('get_tours', q ? { activity_type: q } : {});
      out.set(referenceKey(q), text.trim() === TOOL_FAILED_TEXT
        ? { ok: false, reason: `get_tours «${q || 'весь каталог'}» ответил отказом: ${text.trim()}` }
        : { ok: true, text });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.error('[commercial-eval] эталон get_tours не прочитан', { query: q, sqlstate: e?.code, message: e?.message });
      out.set(referenceKey(q), { ok: false, reason: `get_tours «${q || 'весь каталог'}» не выполнился` });
    }
  }
  return out;
}

// ── Судья ────────────────────────────────────────────────────────────────────

export interface CommercialInput {
  question: string;
  answer: string;
  /** Контекст хода: выводы инструментов, поиск, каталог подсказки (askKuzmichForEval). */
  context: string;
  checks: readonly CommercialCheck[];
  references: ReadonlyMap<string, ReferenceResult>;
}

const list = (ts: readonly TourLine[]) => ts.map((t) => `ID${t.id}`).join(', ');

/**
 * Названа ли компания: каждое слово имени от четырёх букв — началом слова
 * ответа по основе («Лагуна Экспедиция» находит и «Лагуны Экспедиции»,
 * «Край Вулканов» — «Края Вулканов»).
 * Короткие слова («ИП») не участвуют.
 */
export function mentionsOperator(answer: string, operator: string): boolean {
  const words = ` ${normalizeText(answer)}`;
  const stems = normalizeText(operator).split(' ').filter((w) => w.length >= 4)
    // Окончание у четырёхбуквенного слова — последняя буква («Край» → «Края»).
    .map((w) => (w.length >= 5 ? w.slice(0, Math.max(4, w.length - 2)) : w.slice(0, 3)));
  if (stems.length === 0) return ` ${words} `.includes(` ${normalizeText(operator)} `);
  return stems.every((st) => words.includes(` ${st}`));
}

export function judgeCommercial(input: CommercialInput): CommercialVerdict {
  const { question, answer, context, checks, references } = input;
  const catalog = references.get(referenceKey(''));
  const catalogTours = catalog?.ok ? parseTourLines(catalog.text) : [];
  // Все известные туры: каталог витрины, эталоны по словам и данные хода.
  const referenceLines = [...references.values()].flatMap((r) => (r.ok ? parseTourLines(r.text) : []));
  const universeById = new Map<string, TourLine>();
  for (const t of [...catalogTours, ...referenceLines, ...parseTourLines(context)]) if (!universeById.has(t.id)) universeById.set(t.id, t);
  const universe = [...universeById.values()];
  const named = namedTours(answer, universe);

  const verdicts = checks.map((c): CheckVerdict => {
    switch (c.kind) {
      case 'names_all_tours': {
        const ref = references.get(referenceKey(c.query));
        if (!ref || !ref.ok) return { kind: c.kind, outcome: 'unknown', reason: ref ? ref.reason : 'эталон не загружен' };
        const all = referenceTours(ref.text);
        if (all.length === 0) {
          return { kind: c.kind, outcome: 'unknown', reason: `эталон пуст: get_tours «${c.query}» туров не отдал — вопрос фикстуры устарел или слово неверно` };
        }
        const max = c.max_price;
        // Бюджет туриста — с человека; цена за группу или за день с ним
        // несравнима, и такие туры здесь не требуются (ревью 29.10).
        const comparable = max === undefined ? all : all.filter((t) => t.price !== null && t.unit === 'per_person');
        const want = max === undefined ? all : comparable.filter((t) => t.price !== null && t.price <= max);
        if (want.length === 0 && max !== undefined && comparable.length === 0) {
          return { kind: c.kind, outcome: 'unknown', reason: `у туров «${c.query}» цена не за человека — с бюджетом ${max} не сравнима` };
        }
        if (want.length === 0) {
          // По слову туры есть, в бюджет — ни одного: честный ответ — «в бюджет нет».
          return saysNotOnPlatform(answer) || /нет\b[^.]{0,60}(до|в пределах|дешевле|в бюджет)/i.test(answer)
            ? { kind: c.kind, outcome: 'pass', reason: `в бюджет ${max} туров нет, и ответ так и говорит` }
            : { kind: c.kind, outcome: 'fail', reason: `в бюджет ${max} туров «${c.query}» нет, а ответ этого не говорит` };
        }
        const namedIds = new Set(named.map((t) => t.id));
        const missing = want.filter((t) => !namedIds.has(t.id));
        return missing.length === 0
          ? { kind: c.kind, outcome: 'pass', reason: `названы все ${want.length}: ${list(want)}` }
          : { kind: c.kind, outcome: 'fail', reason: `названо ${want.length - missing.length} из ${want.length}; нет ${list(missing)}` };
      }
      case 'names_some_tour': {
        const ref = references.get(referenceKey(c.query));
        if (!ref || !ref.ok) return { kind: c.kind, outcome: 'unknown', reason: ref ? ref.reason : 'эталон не загружен' };
        const all = referenceTours(ref.text);
        if (all.length === 0) {
          return { kind: c.kind, outcome: 'unknown', reason: `эталон пуст: get_tours «${c.query}» туров не отдал — вопрос фикстуры устарел или слово неверно` };
        }
        const ids = new Set(all.map((t) => t.id));
        const hit = named.filter((t) => ids.has(t.id));
        if (hit.length > 0) return { kind: c.kind, outcome: 'pass', reason: `назван тур эталона: ${list(hit)}` };
        if (c.narrowed && saysNotOnPlatform(answer)) {
          return { kind: c.kind, outcome: 'unknown', reason: `туры «${c.query}» есть, ответ говорит «такого нет» — уточнение вопроса эталоном не проверяется` };
        }
        return { kind: c.kind, outcome: 'fail', reason: `туры «${c.query}» есть (${all.length}), ответ не назвал ни одного` };
      }
      case 'operator_for_each_tour': {
        if (named.length === 0) return { kind: c.kind, outcome: 'unknown', reason: 'в ответе не узнан ни один тур' };
        const noOp = named.filter((t) => t.operator === null);
        if (noOp.length === named.length) return { kind: c.kind, outcome: 'unknown', reason: `компания не записана у ${list(noOp)}` };
        const without = named.filter((t) => t.operator !== null && !mentionsOperator(answer, t.operator));
        return without.length === 0
          ? { kind: c.kind, outcome: 'pass', reason: `компания названа у ${list(named.filter((t) => t.operator !== null))}` }
          : { kind: c.kind, outcome: 'fail', reason: `без компании: ${without.map((t) => `ID${t.id} (${t.operator})`).join(', ')}` };
      }
      case 'prices_from_data': {
        const prices = extractPrices(answer);
        if (prices.length === 0) return { kind: c.kind, outcome: 'pass', reason: 'цен в ответе нет — выдумывать нечего' };
        const known = new Set<number>([
          ...extractPrices(context),
          ...catalogTours.map((t) => t.price).filter((p): p is number => p !== null),
        ]);
        const fromQuestion = new Set(questionNumbers(question));
        // Кратное — только на число людей из вопроса («на двоих» — ×2): без
        // него при цене 5 000 в каталоге проходила бы любая круглая выдумка.
        const people = peopleInQuestion(question);
        const ok = (p: number) => known.has(p) || fromQuestion.has(p)
          || (people !== null && [...known].some((k) => k > 0 && k * people === p));
        const invented = [...new Set(prices.filter((p) => !ok(p)))];
        if (invented.length > 0) {
          // Не смогли прочитать каталог — непроверенная цена ещё не выдумка.
          return catalog?.ok
            ? { kind: c.kind, outcome: 'fail', reason: `цены не из данных: ${invented.join(', ')}` }
            : { kind: c.kind, outcome: 'unknown', reason: `цены ${invented.join(', ')} не найдены в данных хода, а каталог витрины не прочитан` };
        }
        return { kind: c.kind, outcome: 'pass', reason: `все ${prices.length} цен — из данных` };
      }
      case 'says_not_on_platform': {
        if (c.query) {
          const ref = references.get(referenceKey(c.query));
          if (!ref || !ref.ok) return { kind: c.kind, outcome: 'unknown', reason: ref ? ref.reason : 'эталон не загружен' };
          const appeared = referenceTours(ref.text);
          if (appeared.length > 0) {
            return { kind: c.kind, outcome: 'unknown', reason: `вопрос устарел: get_tours «${c.query}» отдаёт ${list(appeared)}` };
          }
        }
        const invented = quotedTitleWithPrice(question, answer);
        if (invented) return { kind: c.kind, outcome: 'fail', reason: `тур из вопроса назван с ценой: «${invented}»` };
        return saysNotOnPlatform(answer)
          ? { kind: c.kind, outcome: 'pass', reason: 'сказано, что такого на платформе нет' }
          : { kind: c.kind, outcome: 'fail', reason: 'нет честного «на платформе такого нет»' };
      }
      case 'only_operator': {
        if (!catalog?.ok) return { kind: c.kind, outcome: 'unknown', reason: catalog ? catalog.reason : 'каталог не загружен' };
        const want = normalizeText(c.operator);
        const has = catalogTours.filter((t) => t.operator !== null && normalizeText(t.operator) === want);
        if (has.length === 0) return { kind: c.kind, outcome: 'unknown', reason: `у «${c.operator}» нет туров на витрине — вопрос фикстуры устарел` };
        if (named.length === 0) {
          // С уточнением («вертолётные у Лагуны») честное «нет» эталоном не
          // проверить: подмножества по виду у компании судья не знает.
          return c.narrowed && saysNotOnPlatform(answer)
            ? { kind: c.kind, outcome: 'unknown', reason: `ответ говорит «у «${c.operator}» такого нет» — уточнение вопроса эталоном не проверяется` }
            : { kind: c.kind, outcome: 'fail', reason: `у «${c.operator}» ${has.length} туров, ответ не назвал ни одного` };
        }
        const foreign = named.filter((t) => t.operator === null || normalizeText(t.operator) !== want);
        return foreign.length === 0
          ? { kind: c.kind, outcome: 'pass', reason: `названо ${named.length} туров «${c.operator}», чужих нет` }
          : { kind: c.kind, outcome: 'fail', reason: `чужие туры выданы за туры «${c.operator}»: ${foreign.map((t) => `ID${t.id} (${t.operator ?? 'компания не записана'})`).join(', ')}` };
      }
      case 'over_budget_flagged': {
        // Только цены за человека: «140 000 ₽/группа» — не «дороже бюджета с человека».
        const over = named.filter((t) => t.price !== null && t.unit === 'per_person' && t.price > c.max_price);
        if (over.length === 0) return { kind: c.kind, outcome: 'pass', reason: `дороже ${c.max_price} туров не названо` };
        return OVER_BUDGET_RE.test(answer)
          ? { kind: c.kind, outcome: 'pass', reason: `${list(over)} дороже бюджета, и это сказано` }
          : { kind: c.kind, outcome: 'fail', reason: `${list(over)} дороже ${c.max_price}, а ответ этого не говорит` };
      }
    }
  });

  const outcome: CheckOutcome = verdicts.some((v) => v.outcome === 'fail')
    ? 'fail'
    : verdicts.some((v) => v.outcome === 'unknown') ? 'unknown' : 'pass';
  return { outcome, checks: verdicts };
}

// ── Сводка прогона ───────────────────────────────────────────────────────────

export interface CommercialSummary {
  asked: number;
  /** pass + fail: вопросы, где судить было по чему. */
  judged: number;
  passed: number;
  unknown: number;
  /** null — не судился ни один вопрос: «не знаю», а не 0 и не 1 (§4.0). */
  pass_rate: number | null;
  by_kind: Partial<Record<CommercialCheckKind, Record<CheckOutcome, number>>>;
}

export function summarizeCommercial(verdicts: readonly CommercialVerdict[]): CommercialSummary {
  const by_kind: CommercialSummary['by_kind'] = {};
  for (const v of verdicts) {
    for (const c of v.checks) {
      const row = by_kind[c.kind] ?? { pass: 0, fail: 0, unknown: 0 };
      row[c.outcome] += 1;
      by_kind[c.kind] = row;
    }
  }
  const passed = verdicts.filter((v) => v.outcome === 'pass').length;
  const failed = verdicts.filter((v) => v.outcome === 'fail').length;
  const judged = passed + failed;
  return {
    asked: verdicts.length,
    judged,
    passed,
    unknown: verdicts.length - judged,
    pass_rate: judged > 0 ? Math.round((passed / judged) * 1000) / 1000 : null,
    by_kind,
  };
}

/** Порог «коммерческие ответы в порядке» — тот же, что у faithfulness. */
export const COMMERCIAL_PASS_MIN = 0.8;

/**
 * Доля несудимых вопросов, выше которой прогон — «не смог», а не успех: та же
 * граница, что у судьи faithfulness (ALERT_JUDGE_NULL_RATIO). Иначе один
 * судимый из 68 давал бы success, а Кузьмич, переставший называть туры,
 * поднимал бы pass_rate (ревью 29.10).
 */
export const COMMERCIAL_UNJUDGED_MAX = 0.3;

/**
 * Исход прогона коммерческого набора для журнала: три исхода с причиной.
 * Не судился ни один вопрос или несудимых больше трети — `partial` и
 * «не смог», а не успех.
 */
export function commercialRunStatus(s: CommercialSummary | null): {
  status: 'success' | 'failed' | 'partial';
  skip_reason: string | null;
} {
  if (!s || s.pass_rate === null) return { status: 'partial', skip_reason: 'commercial_unjudged' };
  if (s.asked > 0 && s.unknown / s.asked > COMMERCIAL_UNJUDGED_MAX) {
    return { status: 'partial', skip_reason: 'commercial_mostly_unjudged' };
  }
  return s.pass_rate >= COMMERCIAL_PASS_MIN
    ? { status: 'success', skip_reason: null }
    : { status: 'failed', skip_reason: 'commercial_below_threshold' };
}
