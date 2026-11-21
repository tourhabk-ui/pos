/**
 * Карточки туров под ответом Кузьмича — ровно те туры, что названы в тексте
 * (тест планировщика владельца 21.11).
 *
 * Было: под планом «Горелый 15 000 ₽ и бухта Русская 20 000 ₽» стояли карточки
 * «Вулканы Камчатки (5 дней)» и два вертолёта — их подбирал отдельный поиск
 * по слову вопроса («вулканы»), а не текст ответа. Человек видел одно в
 * тексте и другое в карточках.
 *
 * Стало: туры узнаются в самом ответе — по названию (тем же узнаванием, что
 * эвал полноты списков, `namedTours`) и по номеру «ID70». Цена тур не
 * узнаёт: «15 000 ₽» в плане — не повод показать чужой тур за 15 000.
 * Порядок карточек — порядок упоминания в тексте. Названия в тексте
 * становятся ссылками «[название](/catalog/tours/slug)» на страницу тура.
 *
 * Чистые функции; база — у вызывающего (lib/ai/booking-intent findToursByIds).
 */
import { namedTours, normalizeText, type TourLine } from '@/lib/agents/eval/commercial-checks';

/** Больше карточек под одним ответом не ставим: это уже каталог. */
export const NAMED_TOUR_CARDS_MAX = 8;

export interface NamedTourRef {
  id: string;
  title: string;
}

interface Span { line: number; start: number; end: number }

/** Строчные и ё→е — длина строки не меняется, позиции совпадают с исходной. */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

const ID_RE = (id: string) => new RegExp(`(?<![\\p{L}\\d])ID\\s?${id}(?!\\d)`, 'u');

/** Основа слова — как у узнавания туров: 5 букв, число целиком. */
const stem = (w: string) => (/^\d+$/.test(w) ? w : w.slice(0, 5));
const STOP = new Set(['на', 'и', 'в', 'с', 'к', 'по', 'до', 'от', 'за', 'из', 'для', 'дня', 'дней', 'дн']);
const stems = (t: string) => normalizeText(t).split(' ').filter((w) => /^\d+$/.test(w) || (w.length >= 4 && !STOP.has(w))).map(stem);

/** Тело пункта: без маркера списка и «День N.», до первого « — », «(» или «:». */
function itemSpan(line: string): { start: number; end: number } | null {
  const lead = /^\s*(?:[-•–*]\s+)?(?:(?:День|Дни)\s+\d+(?:[–-]\d+)?\s*[.:—–-]\s*)?/u.exec(line);
  const start = lead ? lead[0].length : 0;
  const rest = line.slice(start);
  const cut = rest.search(/\s+[—–]\s+|\s*\(|:\s|,\s/);
  let end = start + (cut >= 0 ? cut : rest.length);
  while (end > start && /[\s.,;!?»"]/.test(line[end - 1])) end--;
  let s = start;
  while (s < end && /[«"\s]/.test(line[s])) s++;
  return end - s >= 3 ? { start: s, end } : null;
}

function locate(lines: readonly string[], tour: NamedTourRef): Span | null {
  const title = fold(tour.title.trim());
  // 1. Название как есть (без регистра, ё = е).
  for (let i = 0; i < lines.length; i++) {
    const at = fold(lines[i]).indexOf(title);
    if (title.length >= 4 && at >= 0) return { line: i, start: at, end: at + title.length };
  }
  const want = stems(tour.title);
  const covers = (text: string) => {
    if (want.length === 0) return false;
    const have = new Set(normalizeText(text).split(' ').filter(Boolean).map(stem));
    return want.filter((s) => have.has(s)).length / want.length > 0.8;
  };
  // 2. В кавычках «…» — пересказ названия.
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/«([^»]{3,200})»/g)) {
      if (covers(m[1])) {
        const start = (m.index ?? 0) + 1;
        return { line: i, start, end: start + m[1].length };
      }
    }
  }
  // 3. Строка с номером тура или с пересказом названия — тело пункта.
  for (let i = 0; i < lines.length; i++) {
    if (ID_RE(tour.id).test(lines[i]) || covers(lines[i])) {
      const span = itemSpan(lines[i]);
      if (span) return { line: i, ...span };
    }
  }
  return null;
}

/**
 * Туры, названные в ответе, — по порядку первого упоминания. `universe` —
 * туры витрины этого хода (id и название); цены в узнавании не участвуют.
 */
export function toursNamedInAnswer(answer: string, universe: readonly TourLine[]): NamedTourRef[] {
  if (!answer.trim() || universe.length === 0) return [];
  const byName = namedTours(answer, universe.map((t) => ({ ...t, price: null })));
  const ids = new Set(byName.map((t) => t.id));
  for (const t of universe) if (!ids.has(t.id) && ID_RE(t.id).test(answer)) ids.add(t.id);
  const lines = answer.split('\n');
  const found = universe
    .filter((t) => ids.has(t.id))
    .map((t) => ({ ref: { id: t.id, title: t.title }, at: locate(lines, t) }))
    .filter((x) => x.at !== null) as Array<{ ref: NamedTourRef; at: Span }>;
  found.sort((a, b) => a.at.line - b.at.line || a.at.start - b.at.start);
  return found.slice(0, NAMED_TOUR_CARDS_MAX).map((x) => x.ref);
}

/** Уже ссылка или адрес — внутрь не вкладываем. */
function insideLink(line: string, start: number, end: number): boolean {
  for (const m of line.matchAll(/\[[^\]\n]*\]\([^)\s]*\)|https?:\/\/\S+/g)) {
    const s = m.index ?? 0;
    if (start < s + m[0].length && end > s) return true;
  }
  return false;
}

/**
 * Первое упоминание каждого тура — ссылкой «[текст](путь)». Текст ответа не
 * меняется, кроме обёртки: цены, даты и оговорки остаются на месте.
 */
export function linkNamedTours(answer: string, tours: ReadonlyArray<NamedTourRef & { href: string }>): string {
  const lines = answer.split('\n');
  for (const t of tours) {
    if (!t.href.startsWith('/')) continue;
    const at = locate(lines, t);
    if (!at) continue;
    const line = lines[at.line];
    if (insideLink(line, at.start, at.end)) continue;
    const text = line.slice(at.start, at.end).replace(/[[\]]/g, '');
    lines[at.line] = `${line.slice(0, at.start)}[${text}](${t.href})${line.slice(at.end)}`;
  }
  return lines.join('\n');
}
