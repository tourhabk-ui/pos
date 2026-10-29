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
 *  - Тур «назван», если в ответе стоит его название (без кавычек и регистра)
 *    либо его цена, которая среди известных туров принадлежит ему одному.
 *    Пересказ названия без единственной цены не узнаётся — проверка «назвал
 *    все» в этом случае строже правды, а «компания у каждого тура» — мягче.
 *  - Цена считается ценой, только если при числе стоит ₽/руб/тыс/к. Первое
 *    число диапазона без единицы («60–115 тыс.») не проверяется.
 *  - Цена «из данных», если она есть в данных хода, в каталоге витрины на
 *    момент прогона или в самом вопросе (бюджет туриста), либо кратна такой
 *    цене на 2..10 человек («на двоих»). Чужую цену, верную для другого тура,
 *    эта проверка не ловит: принадлежность цены туру — не её предмет.
 *  - Месяц и сезон тура не судятся: в выводе инструмента сезон есть не у всех
 *    туров (у туров с расписанием — только ближайшая дата).
 */
import { z } from 'zod';

// ── Критерии фикстуры ────────────────────────────────────────────────────────

export const CommercialCheckSchema = z.discriminatedUnion('kind', [
  /** Назвать все туры, которые get_tours отдаёт по слову (с max_price — не дороже). */
  z.object({ kind: z.literal('names_all_tours'), query: z.string().min(3), max_price: z.number().int().positive().optional() }),
  /** У каждого названного тура названа компания, которая его проводит. */
  z.object({ kind: z.literal('operator_for_each_tour') }),
  /** Каждая цена ответа — из данных хода, витрины или вопроса. */
  z.object({ kind: z.literal('prices_from_data') }),
  /** Честное «такого на платформе нет». */
  z.object({ kind: z.literal('says_not_on_platform') }),
  /** Названы туры только этой компании, и хотя бы один. */
  z.object({ kind: z.literal('only_operator'), operator: z.string().min(3) }),
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

/** Строка тура в выводе get_tours и в каталоге подсказки (loadTourCatalog). */
export interface TourLine {
  id: string;
  title: string;
  operator: string | null;
  price: number | null;
}

/** ё→е, без регистра и знаков: «Вулкан Толбачик (вертолёт)» → «вулкан толбачик вертолет». */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}

const SPACE = '[ \\u00a0\\u202f]';
const NUM = `\\d{1,3}(?:${SPACE}\\d{3})+|\\d+`;
// Число, необязательная дробь, «тыс»/«к» и валюта. Буква после «к» — это
// слово («км», «кг»), а не тысячи.
const PRICE_RE = new RegExp(
  `(${NUM})(?:[.,](\\d{1,2}))?\\s*(тыс\\.?|тысяч[а-я]*|к(?![а-яёa-z]))?\\s*(₽|руб[а-я]*\\.?|р\\.)?`,
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
    const [, intPart, frac, thousands, currency] = m;
    if (!thousands && !currency) continue;
    const n = toNumber(intPart, frac, Boolean(thousands));
    if (n > 0) out.push(n);
  }
  return out;
}

/** Числа вопроса — бюджет туриста («до 50 000», «50к», «50 тысяч»), от 100. */
export function questionNumbers(question: string): number[] {
  const out: number[] = [];
  for (const m of question.matchAll(PRICE_RE)) {
    const [, intPart, frac, thousands] = m;
    const n = toNumber(intPart, frac, Boolean(thousands));
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
    const price = rest.match(new RegExp(`от (${NUM}) ₽`));
    out.push({
      id: m[1],
      title: m[2],
      operator: op ? op[1].trim() : null,
      price: price ? toNumber(price[1], undefined, false) : null,
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

// Честное «нет»: про платформу, каталог, поиск — не любое «нет» в тексте.
const NOT_ON_PLATFORM_RE = new RegExp([
  'нет на платформе', 'на платформе (?:такого |таких |его |её |их )?(?:тура |туров )?нет', 'на платформе не',
  'в каталоге (?:такого |его |их )?(?:тура |туров )?нет', 'нет в каталоге', 'нет у операторов', 'у операторов (?:платформы )?(?:такого |таких )?(?:тура |туров )?нет',
  'не нашел', 'не нашёл', 'не нашлось', 'не найден', 'нет такого', 'нет таких', 'такого тура нет', 'таких туров нет',
  'не продает', 'не продаёт', 'не продается', 'не продаётся', 'пока нет', 'сейчас нет',
].join('|'), 'i');

// «Дороже бюджета»: тур выше потолка назван — так и сказано.
const OVER_BUDGET_RE = /дороже|выше бюджет|выше вашего|выше твоего|превыша|сверх бюджет|не уклад|за рамк|больше бюджет|за пределами бюджет|вне бюджет/i;

// ── Эталоны ──────────────────────────────────────────────────────────────────

/** Вызов инструмента Кузьмича: имя и аргументы → текст (как у executeKuzmichTool). */
export type ReferenceTool = (name: string, args: Record<string, string>) => Promise<string>;

export type ReferenceResult = { ok: true; text: string } | { ok: false; reason: string };

/** Ключ эталона: get_tours по слову; '' — весь каталог витрины. */
export const referenceKey = (query: string) => `get_tours:${query}`;

/** Текст отказа инструмента (lib/kuzmich/tool-failure) — эталон не прочитан. */
const TOOL_FAILED_TEXT = 'Ошибка при выполнении запроса.';

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
  for (const c of checks) if (c.kind === 'names_all_tours') queries.add(c.query);
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
  // Все известные туры: каталог витрины и всё, что было в данных хода.
  const universeById = new Map<string, TourLine>();
  for (const t of [...catalogTours, ...parseTourLines(context)]) if (!universeById.has(t.id)) universeById.set(t.id, t);
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
        const want = max === undefined ? all : all.filter((t) => t.price !== null && t.price <= max);
        if (want.length === 0) {
          // По слову туры есть, в бюджет — ни одного: честный ответ — «в бюджет нет».
          return NOT_ON_PLATFORM_RE.test(answer) || /нет\b[^.]{0,60}(до|в пределах|дешевле|в бюджет)/i.test(answer)
            ? { kind: c.kind, outcome: 'pass', reason: `в бюджет ${max} туров нет, и ответ так и говорит` }
            : { kind: c.kind, outcome: 'fail', reason: `в бюджет ${max} туров «${c.query}» нет, а ответ этого не говорит` };
        }
        const namedIds = new Set(named.map((t) => t.id));
        const missing = want.filter((t) => !namedIds.has(t.id));
        return missing.length === 0
          ? { kind: c.kind, outcome: 'pass', reason: `названы все ${want.length}: ${list(want)}` }
          : { kind: c.kind, outcome: 'fail', reason: `названо ${want.length - missing.length} из ${want.length}; нет ${list(missing)}` };
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
        const ok = (p: number) => known.has(p) || fromQuestion.has(p)
          || [...known].some((k) => k > 0 && p % k === 0 && p / k >= 2 && p / k <= 10);
        const invented = [...new Set(prices.filter((p) => !ok(p)))];
        if (invented.length > 0) {
          // Не смогли прочитать каталог — непроверенная цена ещё не выдумка.
          return catalog?.ok
            ? { kind: c.kind, outcome: 'fail', reason: `цены не из данных: ${invented.join(', ')}` }
            : { kind: c.kind, outcome: 'unknown', reason: `цены ${invented.join(', ')} не найдены в данных хода, а каталог витрины не прочитан` };
        }
        return { kind: c.kind, outcome: 'pass', reason: `все ${prices.length} цен — из данных` };
      }
      case 'says_not_on_platform':
        return NOT_ON_PLATFORM_RE.test(answer)
          ? { kind: c.kind, outcome: 'pass', reason: 'сказано, что такого на платформе нет' }
          : { kind: c.kind, outcome: 'fail', reason: 'нет честного «на платформе такого нет»' };
      case 'only_operator': {
        if (!catalog?.ok) return { kind: c.kind, outcome: 'unknown', reason: catalog ? catalog.reason : 'каталог не загружен' };
        const want = normalizeText(c.operator);
        const has = catalogTours.filter((t) => t.operator !== null && normalizeText(t.operator) === want);
        if (has.length === 0) return { kind: c.kind, outcome: 'unknown', reason: `у «${c.operator}» нет туров на витрине — вопрос фикстуры устарел` };
        if (named.length === 0) return { kind: c.kind, outcome: 'fail', reason: `у «${c.operator}» ${has.length} туров, ответ не назвал ни одного` };
        const foreign = named.filter((t) => t.operator === null || normalizeText(t.operator) !== want);
        return foreign.length === 0
          ? { kind: c.kind, outcome: 'pass', reason: `названо ${named.length} туров «${c.operator}», чужих нет` }
          : { kind: c.kind, outcome: 'fail', reason: `чужие туры выданы за туры «${c.operator}»: ${foreign.map((t) => `ID${t.id} (${t.operator ?? 'компания не записана'})`).join(', ')}` };
      }
      case 'over_budget_flagged': {
        const over = named.filter((t) => t.price !== null && t.price > c.max_price);
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
 * Исход прогона коммерческого набора для журнала: три исхода с причиной.
 * Не судился ни один вопрос — `partial` и «не смог», а не успех.
 */
export function commercialRunStatus(s: CommercialSummary | null): {
  status: 'success' | 'failed' | 'partial';
  skip_reason: string | null;
} {
  if (!s || s.pass_rate === null) return { status: 'partial', skip_reason: 'commercial_unjudged' };
  return s.pass_rate >= COMMERCIAL_PASS_MIN
    ? { status: 'success', skip_reason: null }
    : { status: 'failed', skip_reason: 'commercial_below_threshold' };
}
