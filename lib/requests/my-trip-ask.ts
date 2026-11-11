/**
 * lib/requests/my-trip-ask.ts
 *
 * Фраза и кнопка «Моя поездка» (#2970) — без базы и сети: их читают
 * клавиатура туриста и «код раньше модели», которым база ради надписи
 * не нужна. Сам ответ — lib/requests/my-trip.
 */

/** Надпись кнопки — одна на MAX и Telegram. */
export const MY_TRIP_BUTTON = 'Моя поездка';

/** Фразы, на которые отвечает «Моя поездка». Целой репликой: вопрос с подробностями — модели. */
const MY_TRIP_ASK = /^(?:моя\s+поездка|мои\s+поездки|мои\s+заявки|моя\s+заявка|что\s+с\s+(?:моей\s+)?заявкой|статус\s+(?:моей\s+)?заявки)\s*[?!.]*$/i;

export function isMyTripAsk(text: string): boolean {
  return MY_TRIP_ASK.test(text.trim().replace(/ё/gi, 'е'));
}

// ── «Написать оператору» под «Моей поездкой» (#2970, шаг 3) ─────────────────
// Разбор кнопки — здесь, без базы: его зовёт маршрутизатор нажатий MAX
// (lib/max/verified-press). Само нажатие — lib/requests/my-trip-write.

/** Цель переписки: лид или заявка на жильё (как ChatTarget lib/requests/request-chat). */
export interface MyTripWriteTarget {
  kind: 'lead' | 'stay';
  id: string;
}

const PREFIX = 'mw:';
/** `mw:l<32 hex>` — лид, `mw:a<32 hex>` — заявка на жильё. Без дефисов: кнопка с подписью ≤ 64 байт. */
const PAYLOAD_RE = /^mw:([la])([0-9a-f]{32})$/;

const compact = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuidOf = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export function myTripWritePayload(target: MyTripWriteTarget): string {
  return `${PREFIX}${target.kind === 'stay' ? 'a' : 'l'}${compact(target.id)}`;
}

export function isMyTripWritePayload(payload: string): boolean {
  return payload.startsWith(PREFIX);
}

export function parseMyTripWrite(payload: string): MyTripWriteTarget | null {
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return null;
  return { kind: m[1] === 'a' ? 'stay' : 'lead', id: uuidOf(m[2]!) };
}

/** Надпись кнопки: у заявки на жильё адресат — хозяин, у прочих — оператор. */
export function myTripWriteText(target: MyTripWriteTarget, n: number | null): string {
  const who = target.kind === 'stay' ? 'Написать хозяину' : 'Написать оператору';
  return n === null ? who : `${who} · ${n}`;
}

// ── «Изменить дату» под «Моей поездкой» (#2970, шаг 3) ──────────────────────
// Слово владельца 11.11: свободной датой тура прямо в чате, без страницы
// тура; пока оператор не ответил — дата меняется сразу, после ответа —
// просьба оператору. Только заявка на тур на дату (лид create_booking_request):
// у запроса мест (тур без расписания) свободных дат нет по построению.
// Само нажатие — lib/requests/my-trip-date.

/** `md:<32 hex>` — показать свободные даты (только чтение). */
const DATE_MENU_RE = /^md:([0-9a-f]{32})$/;
/** `mp:<32 hex><ГГММДД>` — выбрать дату (запись, подписывается). */
const DATE_PICK_RE = /^mp:([0-9a-f]{32})(\d{6})$/;

export function myTripDateMenuPayload(leadId: string): string {
  return `md:${compact(leadId)}`;
}

/** Дата ГГГГ-ММ-ДД кнопкой: ГГММДД (кнопка с подписью ≤ 64 байт). */
export function myTripDatePickPayload(leadId: string, isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-');
  return `mp:${compact(leadId)}${y!.slice(2)}${m}${d}`;
}

export function isMyTripDatePayload(payload: string): boolean {
  return payload.startsWith('md:') || payload.startsWith('mp:');
}

export type MyTripDatePress =
  | { kind: 'menu'; leadId: string }
  | { kind: 'pick'; leadId: string; date: string };

export function parseMyTripDate(payload: string): MyTripDatePress | null {
  const menu = DATE_MENU_RE.exec(payload);
  if (menu) return { kind: 'menu', leadId: uuidOf(menu[1]!) };
  const pick = DATE_PICK_RE.exec(payload);
  if (!pick) return null;
  const v = pick[2]!;
  const date = `20${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4, 6)}`;
  // Битая дата (31.02) — не дата: Date нормализовал бы её в март.
  const probe = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) return null;
  return { kind: 'pick', leadId: uuidOf(pick[1]!), date };
}

/** Надпись кнопки под списком; номер — номер заявки, если их больше одной. */
export function myTripDateText(n: number | null): string {
  return n === null ? 'Изменить дату' : `Изменить дату · ${n}`;
}
