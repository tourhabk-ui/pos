/**
 * Создана ли заявка — по тексту пишущего исполнителя (#2967, 03.11).
 *
 * Исполнители MCP (create_booking_request, create_lead, create_trip_request
 * и др.) отвечают текстом и отказы чаще всего тоже возвращают текстом:
 * «Тур … не найден — заявка не создана», «дата уже прошла — заявка не
 * создана». `runPublicTool` при этом говорит `kind: 'ok'`, а чат Кузьмича
 * отвечал человеку «Заявка создана. Оператор свяжется» на любой такой ответ.
 *
 * Здесь одно правило на все поверхности (веб-чат, MAX, Telegram, части
 * поездки в trip-request):
 *  - «создана» — только по признаку успеха: ключ статуса (он стоит в хвосте
 *    каждого успешного ответа, выданный или «не выдан») или «заявка
 *    принята» / «запрос отправлен ему»;
 *  - «не создана» — по признаку отказа без признака успеха;
 *  - ни того ни другого — «не знаю» (§4.0): человеку не обещаем звонок.
 *
 * Модуль чистый: без базы и без сети.
 */

export type LegName = 'tour' | 'stay' | 'transfer';

export interface LegOutcome { name: LegName; created: boolean; reason: string | null }

export type RequestOutcome =
  | { kind: 'created'; trip: string | null; legs: LegOutcome[]; seatRequest: boolean }
  | { kind: 'not_created'; trip: string | null; legs: LegOutcome[]; reason: string | null }
  | { kind: 'unknown' };

/** Признаки отказа — те же, что держал `legFailed` у частей поездки. */
const FAILED = /не создан|не отправлен|не найден|не принимает/i;
/** Признаки успеха: хвост ключа статуса и слова «принята» / «запрос отправлен ему». */
const CREATED = /Ключ статуса заявки|(?:^|[\s.])(?:Пробная\s+)?заявка(?:\s+оператору)?\s+принята|запрос отправлен ему/i;

/** Текст части или исполнителя: отказ — только если нет признака успеха. */
export function textFailed(text: string): boolean {
  return FAILED.test(text) && !CREATED.test(text);
}

/** Текст исполнителя прямо говорит, что заявка есть. */
export function textCreated(text: string): boolean {
  return CREATED.test(text) && !/^\s*Черновик/i.test(text);
}

const LEG: Record<string, LegName> = { 'Тур': 'tour', 'Жильё': 'stay', 'Машина': 'transfer' };

/**
 * Причина отказа словами человека. Текст исполнителя написан агенту: в нём
 * имена инструментов («уточните через get_tours»), поля («параметр carrier»)
 * и «Заявка не создана.» — это человеку не нужно, отказ мы назовём сами.
 */
export function humanReason(text: string | null | undefined): string | null {
  if (!text) return null;
  const head = text
    .split(/\n\nСкажи человеку|Скажи человеку его языком/)[0]
    .split(/\s*Ключ статуса заявки/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = head.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences
    .filter((s) => !/\b(?:get|create|search|request|make|edit|fetch)_\w+|параметр|\(поле |\bID\b|notify_url|consent/i.test(s))
    .filter((s) => !/^(?:Заявка|Она)\s+не\s+создана\.?$/i.test(s))
    .filter((s) => !/^Черновик/i.test(s))
    .map((s) => s
      .replace(/\s*[—-]\s*(?:заявка|она)\s+не\s+создана\.?/gi, '.')
      .replace(/\s*[—-]\s*(?:запрос|заявка)\s+не\s+отправлен[аы]?\.?/gi, '.')
      .replace(/\s*Заявка не создана\.?/gi, '')
      .replace(/\.{2,}/g, '.')
      .trim())
    .filter((s) => s.length > 1);
  const out = kept.slice(0, 2).join(' ').slice(0, 300).trim();
  return out || null;
}

/** Исход одного ответа исполнителя. */
export function requestOutcome(text: string | null | undefined): RequestOutcome {
  const t = (text ?? '').trim();
  if (!t) return { kind: 'unknown' };
  const trip = /Поездка (TRIP-[A-Z0-9]+):/.exec(t)?.[1] ?? null;
  if (trip) {
    const legs: LegOutcome[] = [];
    for (const m of t.matchAll(/^— (Тур|Жильё|Машина): (создано|НЕ создано)\.\s?(.*)$/gm)) {
      const created = m[2] === 'создано';
      legs.push({ name: LEG[m[1]], created, reason: created ? null : humanReason(m[3]) });
    }
    if (new RegExp(`Поездка ${trip}: ни одна часть не создана`).test(t) || (legs.length > 0 && legs.every((l) => !l.created))) {
      const reasons = legs.filter((l) => l.reason).map((l) => `${LEG_WORD[l.name]} — ${l.reason}`);
      return { kind: 'not_created', trip, legs, reason: reasons.length ? reasons.join(' ') : null };
    }
    if (/создано частей \d+ из \d+/.test(t) || legs.some((l) => l.created)) {
      return { kind: 'created', trip, legs, seatRequest: false };
    }
    return { kind: 'unknown' };
  }
  if (textCreated(t)) return { kind: 'created', trip: null, legs: [], seatRequest: /запрос отправлен ему/i.test(t) };
  if (FAILED.test(t) || /^\s*Черновик/i.test(t)) return { kind: 'not_created', trip: null, legs: [], reason: humanReason(t) };
  return { kind: 'unknown' };
}

export const LEG_WORD: Record<LegName, string> = { tour: 'тур', stay: 'жильё', transfer: 'транспорт' };
