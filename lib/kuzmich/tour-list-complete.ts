/**
 * Полнота списка туров (02.11, эвал критериев 0.765 < 0.8). Модель сокращает
 * список туров места («часть витрины»), теряет комбо-туры (ID40), не пишет
 * компанию (ID27, ID67) и не говорит, что тур дороже бюджета. Правило в
 * промпте не помогло (#2964, #2972) — здесь код после ответа модели.
 *
 * Только данные get_tours этого хода (БД): дописываются недостающие туры
 * фильтрованного запроса с компанией и ценой как в строке инструмента,
 * компания к названным турам без неё и пометка «дороже бюджета». Цены и даты
 * не придумываются: нет цены в строке — цены нет и в дописке.
 */
import { detectEmergency } from '@/lib/safety/sos-detector';
import { asksTripPlan } from '@/lib/kuzmich/answer-quality';
import { asksTourComparison } from '@/lib/kuzmich/tour-ask';
import {
  deniesTours, mentionsOperator, namedTours, parseTourLines, questionNumbers, referenceTours,
  UNIT_CAVEAT_RE, type TourLine,
} from '@/lib/agents/eval/commercial-checks';

/** Больше — это не список места, а каталог: дописывать не нужно. */
export const COMPLETE_LIST_MAX = 15;

export interface ToursCall {
  /** activity_type вызова; пусто — весь каталог, не дописываем. */
  query: string;
  output: string;
}

const OVER_BUDGET_RE = /дороже|выше бюджет|выше вашего|выше твоего|превыша|сверх бюджет|не уклад|за рамк|больше бюджет|вне бюджет/i;
const fmt = (n: number) => n.toLocaleString('ru-RU').replace(/\u00a0/g, ' ');

function priceWords(t: TourLine): string {
  if (t.price === null) return '';
  const unit = t.unit === 'per_tour' ? ' ₽/группа' : t.unit === 'per_day_per_person' ? ' ₽/чел. в день' : t.unit === 'per_person' ? ' ₽/чел.' : ' ₽';
  return `, от ${fmt(t.price)}${unit}`;
}

/** Что значит цена не за человека. Размер группы — только из строки каталога
 *  (мест в туре, слово владельца 03.11); нет его — без пересчёта. */
export function unitCaveat(t: TourLine, budget: number): string {
  if (t.unit === 'per_tour') {
    if (t.groupMax && t.groupMax > 0 && t.price !== null) {
      const each = t.groupMax > 1 ? `, при полной группе ≈ ${fmt(Math.round(t.price / t.groupMax))} ₽/чел.` : '';
      return `цена за группу до ${t.groupMax} чел.${each}`;
    }
    return 'цена за группу, уточните у оператора';
  }
  if (t.unit === 'per_day_per_person') {
    return t.price !== null && t.price > budget
      ? 'цена с человека за день, дороже бюджета уже за один день'
      : 'цена с человека за день, итог зависит от числа дней — уточните у оператора';
  }
  return 'за что цена, не указано — уточните у оператора';
}

function line(t: TourLine): string {
  return `- «${t.title}»${t.operator ? ` — ${t.operator}` : ''}${priceWords(t)}`;
}

/**
 * Бюджет с человека из вопроса: «до 50 000», «дешевле 70 000», «50к». Нет — null.
 * «Дешевле» добавлено 17.11 (ночной эвал, budget-tolbachik-70k): вопрос «тур
 * на Толбачик дешевле 70 000» бюджета не давал, и тур за 60 000 не попадал в
 * поправку к «дешевле 70 000 нет».
 */
export function budgetOf(question: string): number | null {
  if (!/(?:^|[^а-яё])до |бюджет|не дороже|дешевле|не больше|не более|не выше|в пределах|уложиться/i.test(question)) return null;
  const nums = questionNumbers(question).filter((n) => n >= 1000);
  return nums.length > 0 ? Math.max(...nums) : null;
}

const norm = (w: string) => w.toLowerCase().replace(/ё/g, 'е');
const wordsOf = (s: string) => norm(s).split(/[^a-zа-я]+/).filter(Boolean);

/** Слова вопроса, которые не место и не тип: по ним искать нечего. */
const STOP = new Set([
  'какие', 'какой', 'какая', 'какое', 'хочу', 'посмотреть', 'покажи', 'предложения',
  'предлагают', 'операторы', 'оператор', 'рублей', 'тысяч', 'тысячи', 'человека',
  'сравни', 'перечисли', 'захватывают', 'туда', 'стоит', 'сколько', 'бюджет',
  'дешевле', 'дороже', 'пределах', 'варианты', 'предложишь', 'можно', 'выбрать',
  'камчатка', 'камчатки', 'камчатке', 'камчатку', 'туров', 'турах', 'тур', 'туры', 'есть', 'возит', 'почем', 'двоих', 'троих',
]);

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * Запросы к get_tours из слов вопроса (эвал 02.11: модель звала
 * get_tour_details или весь каталог, дописке не было фильтрованного вызова).
 * Слово с опечаткой («горелай», «куриское», «халактырскй») заменяется словом
 * каталога на расстоянии правки ≤ 2 с тем же началом — только слова из БД.
 */
export function questionQueries(question: string, catalogText: string, max = 4): string[] {
  const vocab = [...new Set(wordsOf(catalogText).filter((w) => w.length >= 5))];
  const out: string[] = [];
  const stems = new Set<string>();
  for (const w of wordsOf(question)) {
    if (w.length < 5 || STOP.has(w)) continue;
    let q: string | null = vocab.includes(w) ? w : null;
    if (!q) {
      let best: [string, number] | null = null;
      for (const v of vocab) {
        if (v.slice(0, 2) !== w.slice(0, 2)) continue;
        const dist = lev(w, v);
        if (dist <= 2 && (!best || dist < best[1])) best = [v, dist];
      }
      if (best) q = best[0];
      // Падеж длиннее двух правок («курильском» → основа каталога) — само слово.
      else if (vocab.some((v) => v.slice(0, 5) === w.slice(0, 5))) q = w;
    }
    if (!q) continue;
    const st = q.slice(0, 5);
    if (stems.has(st)) continue;
    stems.add(st);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/** Запрос вызова — из слов вопроса (questionQueries): эти туры — ответ на вопрос, а не соседи. */
function askedQuery(query: string, asked: readonly string[]): boolean {
  const q = norm(query.trim());
  return asked.some((a) => a === q);
}

export interface CompleteOptions {
  /**
   * Вопрос о продавце (resolveSellerInText): список туров — его, дописка не
   * прибавляет туров других компаний и не приписывает названные туры другим
   * по совпадению названия (ночной эвал 17.11: «Горный массив Вачкажец» гида
   * ушёл в «Кто проводит» как тур другой компании). Бюджет — как обычно.
   */
  seller?: boolean;
}

/**
 * calls — вызовы get_tours хода (и дозапросы по словам вопроса); catalogText —
 * весь каталог (БД): по нему компания к турам, названным по заголовку, даже
 * если модель брала их из get_tour_details или из каталога без фильтра.
 */
export function completeTourList(answer: string, question: string, calls: readonly ToursCall[], catalogText = '', opts: CompleteOptions = {}): string {
  // SOS (разбор 03.11, п.6): к экстренному ответу список туров не дописывается.
  if (detectEmergency(question).detected) return answer;
  // Просьба о плане (аудит планировщика 07.11, K1): ответ — сам план, туры в
  // нём выбраны по дням и датам. Дописка «Ещё по запросу» прицепляла к плану
  // на июль весь список вида, зимнюю рыбалку тоже (ai-debug run 22).
  if (asksTripPlan(question)) return answer;
  // Сравнение названных туров (ai-debug run 23): ответ — эти туры рядом, а
  // «Ещё по запросу» к нему — список, о котором не спрашивали.
  if (asksTourComparison(question)) return answer;
  const byId = new Map<string, TourLine>();
  for (const c of calls) {
    if (!c.query.trim()) continue;
    const r = referenceTours(c.output);
    // Порог — на каждый запрос: «вулкан» даёт полкаталога, «Горелый» — список места.
    if (r.length > COMPLETE_LIST_MAX) continue;
    for (const t of r) if (!byId.has(t.id)) byId.set(t.id, t);
  }
  const ref = [...byId.values()];
  // Вселенная для «кто проводит»: строки всех вызовов с ценой, каталог — только
  // по названию (цена без названия в каталоге неоднозначна).
  const uni = new Map<string, TourLine>();
  for (const c of calls) for (const t of parseTourLines(c.output)) if (!uni.has(t.id)) uni.set(t.id, t);
  const catalogNamed = namedTours(answer, parseTourLines(catalogText).filter((t) => !uni.has(t.id)).map((t) => ({ ...t, price: null })));
  const namedAll = [...namedTours(answer, [...uni.values()]), ...catalogNamed.map((t) => uni.get(t.id) ?? parseTourLines(catalogText).find((x) => x.id === t.id) ?? t)];
  const budget = budgetOf(question);
  const fits = (t: TourLine) => budget === null || (t.unit === 'per_person' && t.price !== null && t.price <= budget);
  const namedIds = new Set(namedAll.map((t) => t.id));
  // «Туров нет», а по словам вопроса туры есть (ночной эвал 17.11: «Налычево
  // — туров нет» при пяти, «дешевле 70 000 нет» при туре за 60 000). Модель
  // ответила неправду о витрине — поправка тем же ответом, только туры по
  // словам самого вопроса и в бюджет. Вопрос о продавце — не здесь: «у него
  // нет» правда, даже если у других компаний такие туры есть.
  const asked = questionQueries(question, catalogText);
  const answerRef = new Map<string, TourLine>();
  for (const c of calls) {
    if (!c.query.trim() || !askedQuery(c.query, asked)) continue;
    const r = referenceTours(c.output);
    if (r.length > COMPLETE_LIST_MAX) continue;
    for (const t of r) if (!answerRef.has(t.id)) answerRef.set(t.id, t);
  }
  const denied = !opts.seller && deniesTours(answer)
    ? [...answerRef.values()].filter((t) => !namedIds.has(t.id) && fits(t))
    : [];
  // Ответ не о турах (отказ, безопасность, вопрос) — не трогаем, кроме ложного «туров нет».
  if (namedAll.length === 0 && denied.length === 0) return answer;
  const named = ref.length > 0 ? namedTours(answer, ref) : [];
  const deniedIds = new Set(denied.map((t) => t.id));
  // Ответ без единого названного тура дополняется только поправкой: соседние
  // списки к отказу или к ответу о безопасности не приклеиваются.
  const missing = opts.seller || namedAll.length === 0 || (named.length === 0 && ref.length === 0)
    ? []
    : ref.filter((t) => !namedIds.has(t.id) && !deniedIds.has(t.id) && fits(t));
  const seen = new Set<string>();
  const noCompany = opts.seller
    ? []
    : namedAll.filter((t) => t.operator && !mentionsOperator(answer, t.operator) && !seen.has(t.id) && seen.add(t.id));
  const over = budget === null ? [] : namedAll.filter((t) => t.unit === 'per_person' && t.price !== null && t.price > budget);
  const parts: string[] = [];
  if (denied.length > 0) {
    const head = budget === null
      ? 'Поправка: по запросу на платформе туры есть:'
      : `Поправка: в бюджет ${fmt(budget)} ₽ на платформе есть:`;
    parts.push(`${head}\n${denied.map(line).join('\n')}`);
  }
  if (missing.length > 0) parts.push(`Ещё по запросу на платформе:\n${missing.map(line).join('\n')}`);
  if (noCompany.length > 0) parts.push(`Кто проводит:\n${noCompany.map((t) => `- «${t.title}» — ${t.operator}`).join('\n')}`);
  if (over.length > 0 && !OVER_BUDGET_RE.test(answer)) {
    parts.push(`Дороже бюджета ${fmt(budget as number)} ₽:\n${over.map(line).join('\n')}`);
  }
  // Цена не за человека (02.11, эвал budget-fish-20k): у рыбалки «₽/группа»
  // и «₽/чел. в день». Размер группы — из строки get_tours («за группу до N чел.»,
  // мест в туре, 03.11); нет его — не делим, а говорим, за что цена.
  if (budget !== null && !UNIT_CAVEAT_RE.test(answer)) {
    const ids = new Set<string>();
    const nonComparable = [...ref, ...namedAll].filter((t) =>
      t.price !== null && t.unit !== 'per_person' && !ids.has(t.id) && ids.add(t.id));
    if (nonComparable.length > 0) {
      parts.push(`Цена не за человека — с бюджетом ${fmt(budget)} ₽ напрямую не сравнить:\n${nonComparable.map((t) => `${line(t)} — ${unitCaveat(t, budget)}`).join('\n')}`);
    }
  }
  if (parts.length === 0) return answer;
  return `${answer.trimEnd()}\n\n${parts.join('\n\n')}\nЦены — ориентир из каталога, места и даты подтверждает оператор.`;
}

/**
 * Строки инструмента get_tours, на которых стоит дописка completeTourList.
 * Дописка берёт туры прямыми вызовами get_tours мимо журнала хода, и судья
 * faithfulness их не видел: «туров нет в контексте» (эвал 03.11, route-1/5).
 * Возвращаем только строки названных в дописке туров — не весь каталог,
 * чтобы не вытеснить остальной контекст судьи.
 */
export function completionSources(before: string, after: string, outputs: readonly string[]): string {
  if (after === before || !after.startsWith(before.trimEnd())) return '';
  const tail = after.slice(before.trimEnd().length);
  const titles = [...tail.matchAll(/«([^»]+)»/g)].map((m) => m[1]);
  if (!titles.length) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const out of outputs) {
    for (const l of out.split('\n')) {
      const t = l.trim();
      if (!t || seen.has(t) || !titles.some((x) => t.includes(`"${x}"`))) continue;
      seen.add(t);
      lines.push(t);
    }
  }
  return lines.join('\n');
}
