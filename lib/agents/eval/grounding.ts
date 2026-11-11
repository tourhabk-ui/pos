/**
 * lib/agents/eval/grounding.ts
 *
 * Детектор незаземлённых фактов в ответах Кузьмича.
 *
 * Правило платформы (CLAUDE.md §8): критичные факты — цены, телефоны,
 * наличие мест — только из инструментов/БД, самоотчётам модели не верить.
 * Инсайт J-Lens (Anthropic, июль 2026): модель не имеет доступа к ~90%
 * собственных процессов — её «я проверил» ничего не гарантирует. Проверять
 * можно только поведение: если в ответе есть конкретика, а инструменты
 * в этом ходу не вызывались — факт взят «из головы».
 *
 * Чистый модуль без сети/БД — детектор вызывается из outcomes-грейдера.
 */

/**
 * Имена инструментов Кузьмича, дающие заземление фактам (данные из БД).
 * compare_tours — цены, итог за группу и даты туров из базы (29.10): без него
 * честный ответ по сравнению судился «незаземлённым». Каждый инструмент
 * реестра обязан быть здесь или в списке причин сторожа
 * (tests/unit/grounding.test.ts, NOT_GROUNDING).
 */
const DATA_TOOL_PREFIXES = ['search_', 'get_guardian_context', 'get_tour', 'check_', 'compare_tours'];

export type GroundingSignal = 'price' | 'phone' | 'availability';

const SIGNAL_PATTERNS: Record<GroundingSignal, RegExp> = {
  // «15000 ₽», «15 000 руб», «от 15 тыс. рублей», «стоит 15к»
  price: /\d[\d\s]*\s*(₽|руб|тыс\.?\s*руб|тысяч|к\b)|цена\s+\d|стоит\s+\d/i,
  // Телефоны: +7/8 с 10 цифрами в любых разделителях
  phone: /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/,
  // «есть места», «осталось 3 места», «свободно на завтра»
  availability: /есть (свободные )?места|осталось \d+ мест|свободн(о|ы) (на|в)|места (есть|доступны)/i,
};

// Экстренные телефоны — легитимны без инструментов: их источник — код
// (lib/safety/sos-detector.ts, промпт), а не выдумка модели.
const EMERGENCY_PHONES_RE = /(?<!\d)112(?!\d)|23-53-62|30-10-50|41-27-30/;

/**
 * Три исхода, а не два (§4.0).
 *
 * `unknown` — телеметрия вызовов не пришла: чем заземлён ответ, неизвестно.
 * Это НЕ `grounded`. Находка аудита 08.09: при отсутствии `toolsRan` грейдер
 * писал `ungrounded: false`, то есть отвечал «заземлено» на вопрос, которого
 * не проверял. Место, где нельзя сказать «не знаю», заполняется враньём.
 */
export type GroundingVerdict = 'grounded' | 'ungrounded' | 'unknown';

export interface GroundingAssessment {
  verdict: GroundingVerdict;
  signals: GroundingSignal[];
  /** Почему так решено — для строки в отчёте и в логе. */
  reason: string;
}

/**
 * Один вызов инструмента и его исход.
 *
 * Имя — не доказательство: инструмент мог выполниться и вернуть «ничего не
 * найдено», а ответ всё равно назвал цену. Заземляет только вызов, который
 * ПРИНЁС ДАННЫЕ.
 */
export interface ToolRun {
  name: string;
  producedData: boolean;
  /**
   * Сырой вывод инструмента. Нужен ОЦЕНКЕ faithfulness, а не этой оценке
   * заземления: судье нужно показать то, ЧЕМ ответ обоснован, иначе он судит
   * против пустоты и всякий содержательный ответ объявляет выдумкой (прогон
   * 07.09: context_len 0 во всех десяти вопросах, pass_rate 0.5).
   *
   * `assessGrounding` его НЕ читает и читать не должен: заземление судится по
   * факту «инструмент принёс данные», а не по их содержанию. Поле необязательно
   * — вызывающие, которым содержимое не нужно, его не заполняют.
   */
  output?: string;
}

/** Какие сигналы «конкретных фактов» есть в ответе. Экспортирован для тестов. */
export function detectFactSignals(answer: string): GroundingSignal[] {
  const signals: GroundingSignal[] = [];
  for (const [signal, re] of Object.entries(SIGNAL_PATTERNS) as [GroundingSignal, RegExp][]) {
    if (signal === 'phone') {
      // Ответ, где все телефоны — экстренные, не флагуем
      const stripped = answer.replace(EMERGENCY_PHONES_RE, '');
      if (re.test(stripped)) signals.push(signal);
    } else if (re.test(answer)) {
      signals.push(signal);
    }
  }
  return signals;
}

/**
 * Инструменты, чей ответ несёт цены туров не всегда (разбор плохих оценок
 * 11.11, #3179): план поездки — смету и цены туров, если план собрался;
 * справка о месте — туры к месту с ценами, если они есть. План без дней —
 * отказ словами, место без туров — справка без цен: такой вызов цену в ответе
 * не заземляет. До этого все три стояли «ПРОБЕЛОМ», и честный план с ценами
 * из сметы судился «незаземлённым» — три из шести плохих оценок недели.
 */
const PRICE_BEARING_TOOLS: ReadonlySet<string> = new Set(['make_trip_plan', 'edit_trip_plan', 'get_place_info']);

/** Принёс ли вызов данные, которыми заземляется конкретика ответа. */
export function groundsFacts(r: ToolRun): boolean {
  if (!r.producedData) return false;
  if (DATA_TOOL_PREFIXES.some((p) => r.name.startsWith(p))) return true;
  return PRICE_BEARING_TOOLS.has(r.name) && typeof r.output === 'string' && pricesIn(r.output).length > 0;
}

/** Принёс ли данные хотя бы один инструмент «данных». */
export function ranDataTool(runs: readonly ToolRun[]): boolean {
  return runs.some(groundsFacts);
}

/**
 * Ответ с конкретикой (цены/телефоны/наличие) без единого инструмента данных,
 * принёсшего результат, — незаземлён: факты взяты не из БД платформы.
 *
 * `runs === undefined` — телеметрии нет. Тогда исход `unknown`: судить не о
 * чем, и молча записывать «заземлено» нельзя.
 */
/** Все числа текста, «15 000» и «15\u00a0000» — как 15000. */
function numbersOf(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+/g)) {
    out.add(Number(m[0].replace(/[ \u00a0\u202f]/g, '')));
  }
  return out;
}

/**
 * Цены ответа — суммы рядом с «₽/руб/тыс». «15 тыс.» читается как 15000.
 * Экспортирован для тестов.
 */
export function pricesIn(answer: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)\s*(тыс\.?|тысяч\w*|к\b)?\s*(₽|руб|р\.)/gi;
  for (const m of answer.matchAll(re)) {
    const n = Number(m[1]!.replace(/[ \u00a0\u202f]/g, ''));
    out.push(m[2] ? n * 1000 : n);
  }
  return out;
}

/** Служебные слова названий: по ним тур не узнаётся («тур», «вулкан»). */
const TITLE_GENERIC = new Set(['тур', 'туры', 'тура', 'вулкан', 'вулкана', 'вулканы', 'озеро', 'озера', 'поездка', 'экскурсия',
  'восхождение', 'путешествие', 'программа', 'камчатка', 'камчатки', 'камчатке', 'однодневный', 'дневный', 'группа',
  'индивидуальный', 'групповой', 'день', 'дней', 'дня', 'ночь', 'ночей']);

function stemsOf(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}]+/gu) ?? [])]
    .filter((w) => w.length >= 5 && !TITLE_GENERIC.has(w))
    .map((w) => w.slice(0, Math.max(5, w.length - 2)));
}

interface CatalogPrice { stems: string[]; prices: Set<number> }

/** Строки каталога «ID12: "Название" … от 45 000 р/чел …» — название и числа строки после него. */
function catalogTours(catalogText: string): CatalogPrice[] {
  const out: CatalogPrice[] = [];
  for (const line of catalogText.split('\n')) {
    const m = line.match(/^\s*(?:[•\-*]\s*)?(?:ID\d+:\s*)?"([^"]+)"(.*)$/) ?? line.match(/^\s*[•\-*]\s*([^—–:]+?)\s*[—–:]\s*(.*)$/);
    if (!m) continue;
    const stems = stemsOf(m[1]!);
    // Цена — до первого «|»: дальше оператор, места и даты.
    if (stems.length) out.push({ stems, prices: numbersOf(m[2]!.split('|')[0]!) });
  }
  return out;
}

/** Фраза ответа, где стоит цена: до точки, перевода строки или «;». */
function clauseAround(answer: string, at: number): string {
  const before = answer.slice(0, at);
  const from = Math.max(before.lastIndexOf('\n'), before.search(/[.!?;][^.!?;]*$/)) + 1;
  const rest = answer.slice(at);
  const to = rest.search(/[\n;!?]|\.(?!\d)\s/);
  return answer.slice(from, to < 0 ? answer.length : at + to).toLowerCase().replace(/ё/g, 'е');
}

/**
 * Каждая цена ответа — цена НАЗВАННОГО рядом тура из каталога базы.
 *
 * Свод плохих оценок 03.11: 20 из 24 «незаземлённых» — цена без вызова
 * инструмента, хотя каталог туров С ЦЕНАМИ уже лежит в промпте. Разбор
 * 03.11 (п.5): совпадения числа с каким-нибудь числом каталога мало —
 * «Курильское — 12 000 ₽», когда 12 000 стоит Авачинский, тоже совпало бы.
 * Теперь цена заземлена, только если в той же фразе назван тур и это его
 * цена. Тур не назван — не заземлено.
 */
export function pricesMatchCatalog(answer: string, catalogText: string): boolean {
  if (!catalogText) return false;
  const tours = catalogTours(catalogText);
  const re = /(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)\s*(тыс\.?|тысяч\w*|к\b)?\s*(₽|руб|р\.)/gi;
  let any = false;
  for (const m of answer.matchAll(re)) {
    any = true;
    const n = Number(m[1]!.replace(/[ \u00a0\u202f]/g, ''));
    const price = m[2] ? n * 1000 : n;
    const clause = clauseAround(answer, m.index!);
    const named = tours.filter((t) => {
      const hit = t.stems.filter((st) => clause.includes(st)).length;
      return hit > 0 && hit * 2 >= t.stems.length;
    });
    if (!named.some((t) => t.prices.has(price))) return false;
  }
  return any;
}

export function assessGrounding(
  answer: string,
  runs: readonly ToolRun[] | undefined,
  opts: { catalogText?: string } = {},
): GroundingAssessment {
  const signals = detectFactSignals(answer);
  if (signals.length === 0) {
    return { verdict: 'grounded', signals: [], reason: 'конкретики в ответе нет — заземлять нечего' };
  }
  if (runs === undefined) {
    return {
      verdict: 'unknown',
      signals,
      reason: 'конкретика есть, а список вызовов инструментов не передан — проверить заземление не на чем',
    };
  }
  if (ranDataTool(runs)) {
    return { verdict: 'grounded', signals, reason: 'инструмент данных отработал и вернул результат' };
  }
  // Только цены и все — из каталога базы в промпте: заземлено каталогом.
  // Телефоны и наличие мест каталогом не заземляются — им нужен инструмент.
  if (opts.catalogText && signals.every((s) => s === 'price') && pricesMatchCatalog(answer, opts.catalogText)) {
    return { verdict: 'grounded', signals, reason: 'цены совпадают с каталогом туров из базы (подсказка промпта)' };
  }
  const tried = runs.length === 0
    ? 'инструменты не вызывались'
    : `инструменты вызывались (${runs.map((r) => r.name).join(', ')}), но данных не принесли`;
  return { verdict: 'ungrounded', signals, reason: `конкретика без данных платформы: ${tried}` };
}
