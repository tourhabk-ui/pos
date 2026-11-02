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
import {
  mentionsOperator, namedTours, questionNumbers, referenceTours,
  type TourLine,
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

function line(t: TourLine): string {
  return `- «${t.title}»${t.operator ? ` — ${t.operator}` : ''}${priceWords(t)}`;
}

/** Бюджет с человека из вопроса: «до 50 000», «50к». Нет — null. */
export function budgetOf(question: string): number | null {
  if (!/(?:^|[^а-яё])до |бюджет|не дороже|в пределах|уложиться/i.test(question)) return null;
  const nums = questionNumbers(question).filter((n) => n >= 1000);
  return nums.length > 0 ? Math.max(...nums) : null;
}

export function completeTourList(answer: string, question: string, calls: readonly ToursCall[]): string {
  const byId = new Map<string, TourLine>();
  for (const c of calls) {
    if (!c.query.trim()) continue;
    for (const t of referenceTours(c.output)) if (!byId.has(t.id)) byId.set(t.id, t);
  }
  const ref = [...byId.values()];
  if (ref.length === 0 || ref.length > COMPLETE_LIST_MAX) return answer;
  const named = namedTours(answer, ref);
  // Ответ не о турах (отказ, безопасность, вопрос) — не трогаем.
  if (named.length === 0) return answer;
  const budget = budgetOf(question);
  const fits = (t: TourLine) => budget === null || (t.unit === 'per_person' && t.price !== null && t.price <= budget);
  const namedIds = new Set(named.map((t) => t.id));
  const missing = ref.filter((t) => !namedIds.has(t.id) && fits(t));
  const noCompany = named.filter((t) => t.operator && !mentionsOperator(answer, t.operator));
  const over = budget === null ? [] : named.filter((t) => t.unit === 'per_person' && t.price !== null && t.price > budget);
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Ещё по запросу на платформе:\n${missing.map(line).join('\n')}`);
  if (noCompany.length > 0) parts.push(`Кто проводит:\n${noCompany.map((t) => `- «${t.title}» — ${t.operator}`).join('\n')}`);
  if (over.length > 0 && !OVER_BUDGET_RE.test(answer)) {
    parts.push(`Дороже бюджета ${fmt(budget as number)} ₽:\n${over.map(line).join('\n')}`);
  }
  if (parts.length === 0) return answer;
  return `${answer.trimEnd()}\n\n${parts.join('\n\n')}\nЦены — ориентир из каталога, места и даты подтверждает оператор.`;
}
