/**
 * Числа в намерении лида — только те, что названы в заявке (§4.0).
 *
 * Повод — тестовая заявка владельца 10.10 (две вахтовки на Горелый через
 * create_lead). Квалификатор вернул «группа 52 чел.», перемножив «2 вахтовки
 * по 26 мест», и «бюджет 150 000 ₽», умножив «75 000 ₽ за машину» на две
 * машины. Дальше выдумка размножилась: Bull записал «(сильный) Назван точный
 * бюджет: 150 000 ₽», а в предложении клиенту появилось «это ровно ваш
 * бюджет». Промпт запрещал додумывать и раньше, но запрет без проверки
 * остаётся пожеланием.
 *
 * Здесь проверка. Число модели остаётся, только если оно стоит в тексте
 * заявки рядом со словом своего рода (люди, деньги, дни). Иначе — null,
 * «не названо». Поле формы (group_size, budget_rub) — слово самого человека,
 * оно главнее модели.
 *
 * Условие необходимое, но не достаточное: модель может взять число, которое в
 * тексте есть, но значит другое. Зато числа, которого в тексте нет, она взять
 * не может, а 52 и 150 000 появились 10.10 именно так.
 */

export interface GroundingSource {
  /** Слова человека: комментарий, маршрут, желаемые даты. */
  text: string;
  /** Поле формы «размер группы» — главнее модели. */
  formGroupSize: number | null;
  /** Поле формы «бюджет» — главнее модели. */
  formBudgetRub: number | null;
  /** Данные заявки (план поездки и т. п.): там бывают взрослые и дети числами. */
  sourceData: Record<string, unknown> | null;
}

export interface GroundedNumbers {
  group_size: number | null;
  budget_rub: number | null;
  duration_days: number | null;
}

interface Mention {
  value: number;
  start: number;
  end: number;
  /** «двое», «втроём»: слово само говорит, что речь о людях. */
  people: boolean;
}

// Цифры с разделителем тысяч, дробью и множителем: «75 000», «1,5 млн», «100к».
// Буквенные границы — явными классами: \b в JS не знает кириллицы.
const DIGITS_RE = /(?<![\d.,])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d+))?(?:\s*(тыс[а-яё]*\.?|к(?![а-яё])|k(?![a-z])|млн\.?|миллион[а-яё]*))?/giu;

const WORD_NUMBERS: Record<string, number> = {
  один: 1, одна: 1, одного: 1, одной: 1, одну: 1,
  два: 2, две: 2, двух: 2,
  три: 3, трёх: 3, трех: 3,
  четыре: 4, четырёх: 4, четырех: 4,
  пять: 5, пяти: 5,
  шесть: 6, шести: 6,
  семь: 7, семи: 7,
  восемь: 8, восьми: 8,
  девять: 9, девяти: 9,
  десять: 10, десяти: 10,
  двенадцать: 12, пятнадцать: 15, двадцать: 20,
};

const COLLECTIVE: Record<string, number> = {
  двое: 2, двоих: 2, вдвоём: 2, вдвоем: 2,
  трое: 3, троих: 3, втроём: 3, втроем: 3,
  четверо: 4, четверых: 4, вчетвером: 4,
  пятеро: 5, пятерых: 5, впятером: 5,
  шестеро: 6, шестерых: 6, вшестером: 6,
  семеро: 7, семерых: 7, всемером: 7,
};

function multiplier(unit: string | undefined): number {
  if (!unit) return 1;
  const u = unit.toLowerCase();
  if (u.startsWith('млн') || u.startsWith('миллион')) return 1_000_000;
  return 1000; // тыс, к, k
}

export function numberMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(DIGITS_RE)) {
    const whole = Number(m[1].replace(/[   ]/g, ''));
    const frac = m[2] ? Number(`0.${m[2]}`) : 0;
    const value = Math.round((whole + frac) * multiplier(m[3]));
    const start = m.index ?? 0;
    if (Number.isFinite(value)) out.push({ value, start, end: start + m[0].length, people: false });
  }
  for (const m of text.matchAll(/[а-яё]+/giu)) {
    const w = m[0].toLowerCase();
    const start = m.index ?? 0;
    if (w in COLLECTIVE) out.push({ value: COLLECTIVE[w], start, end: start + w.length, people: true });
    else if (w in WORD_NUMBERS) out.push({ value: WORD_NUMBERS[w], start, end: start + w.length, people: false });
  }
  return out;
}

// Слова «о людях» вокруг числа. «нас» и «пар» — целыми словами; ключи плана
// по-английски — на случай, если данные заявки попали в текст.
const PEOPLE_RE = /чел|взросл|турист|гост|участник|дет(?:ей|и|ьми|ям)(?![а-яё])|ребён|ребен|пассажир|групп|(?<![а-яё])нас(?![а-яё])|семь[яеиюёй]|компани|друз|коллег|школьник|студент|adults|children|people|guests/iu;

// Слова «о бюджете». Цена чего-то («75 000 ₽ за машину») бюджетом клиента не
// является: рядом с ней этих слов нет.
const BUDGET_RE = /бюджет|готов|рассчитыва|не дороже|не больше|не более|в пределах|максимум|потрат|не выше|располага|уложить|(?<![а-яё])до(?![а-яё])|budget/iu;

function around(text: string, m: Mention, before: number, after: number): string {
  return text.slice(Math.max(0, m.start - before), Math.min(text.length, m.end + after));
}

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** Числа о людях и деньгах в данных заявки (план: взрослые + дети). */
function sourceCandidates(data: Record<string, unknown> | null): { group: Set<number>; budget: Set<number> } {
  const group = new Set<number>();
  const budget = new Set<number>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x) => walk(x, depth + 1)); return; }
    const obj = node as Record<string, unknown>;
    const adults = asPositiveInt(obj.adults);
    const children = typeof obj.children === 'number' && obj.children >= 0 ? Math.round(obj.children) : null;
    if (adults !== null) {
      group.add(adults);
      if (children !== null) group.add(adults + children);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (/^(group_?size|groupsize|participants|people|guests|pax|travell?ers)$/i.test(k)) {
        const n = asPositiveInt(v);
        if (n !== null) group.add(n);
      } else if (/^(budget|budget_?rub|budgetrub)$/i.test(k)) {
        const n = asPositiveInt(v);
        if (n !== null) budget.add(n);
      } else {
        walk(v, depth + 1);
      }
    }
  };
  walk(data, 0);
  return { group, budget };
}

export function groupAttested(text: string, n: number): boolean {
  return numberMentions(text).some((m) =>
    m.value === n && (m.people || PEOPLE_RE.test(around(text, m, 24, 24))));
}

export function budgetAttested(text: string, n: number): boolean {
  return numberMentions(text).some((m) =>
    m.value === n && BUDGET_RE.test(around(text, m, 30, 20)));
}

export function durationAttested(text: string, n: number): boolean {
  for (const m of numberMentions(text)) {
    const after = text.slice(m.end, m.end + 14).toLowerCase();
    const unit = after.match(/^\s*(?:-\s*)?(?:х\s*)?(дн|ден|сут|недел|ноч)/u)?.[1];
    if (!unit) continue;
    if ((unit === 'дн' || unit === 'ден' || unit === 'сут') && n === m.value) return true;
    if (unit === 'недел' && n === m.value * 7) return true;
    if (unit === 'ноч' && (n === m.value || n === m.value + 1)) return true;
  }
  // «на неделю» без числа.
  return n === 7 && /(?<![а-яё])(?:на|за|одн[ау])\s+недел[юя](?![а-яё])/iu.test(text);
}

/**
 * Числа модели — сквозь проверку по тексту. Поле формы главнее модели;
 * не подтверждённое текстом число становится null.
 */
export function groundIntentNumbers(
  model: { group_size?: unknown; budget_rub?: unknown; duration_days?: unknown },
  src: GroundingSource,
): GroundedNumbers {
  const fromSource = sourceCandidates(src.sourceData);

  const modelGroup = asPositiveInt(model.group_size);
  const group_size = asPositiveInt(src.formGroupSize)
    ?? (modelGroup !== null && (fromSource.group.has(modelGroup) || groupAttested(src.text, modelGroup)) ? modelGroup : null);

  const modelBudget = asPositiveInt(model.budget_rub);
  const budget_rub = asPositiveInt(src.formBudgetRub)
    ?? (modelBudget !== null && (fromSource.budget.has(modelBudget) || budgetAttested(src.text, modelBudget)) ? modelBudget : null);

  const modelDays = asPositiveInt(model.duration_days);
  const duration_days = modelDays !== null && durationAttested(src.text, modelDays) ? modelDays : null;

  return { group_size, budget_rub, duration_days };
}
