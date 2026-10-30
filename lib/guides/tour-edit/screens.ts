/**
 * Экраны «Мои туры» гида в кабинете в чате (MAX и Telegram) — тексты и
 * кнопки, без базы. Персональных данных здесь нет: тур, цена, даты и
 * сколько мест записано числом — поэтому экраны идут и в Telegram.
 *
 * Всё, что ввёл человек (название и тексты тура), экранируется: HTML
 * разбирает мессенджер.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { cabinetNavRow, type CabinetButton, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import { cabinetPayload, TOUR_DATES_MAX_PAGE } from '@/lib/chat-cabinet/payload';
import { ruShort } from '@/lib/analytics/kamchatka-day';
import { formatRub } from '@/lib/transfers/charter-format';
import { PRICE_UNIT_LABELS } from '@/lib/tours/labels';
import { tourPath } from '@/lib/tours/tour-url';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';
import type { TourProgramStep } from '@/lib/tours/tour-write';
import { FIELD_LABEL, LIMITS, type EditField, type EditReject, type EditValue } from './parse';
import { DRAFT_TTL_HOURS, type ChatTour, type TourDay } from './store';

const BUTTON_TEXT_MAX = 40;
/** Дней на странице дат. */
export const DAYS_PER_PAGE = 14;
/** Сколько туров-кнопок в выборе (по числу в payload: 0–7). */
export const CHOOSE_MAX = 8;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function buttonText(s: string): string {
  return clip(s.replace(/\s+/g, ' '), BUTTON_TEXT_MAX);
}

function screen(lines: Array<string | null | undefined>, rows: CabinetButton[][]): CabinetScreen {
  return {
    text: lines.filter((l): l is string => typeof l === 'string').join('\n'),
    rows: [...rows.filter((r) => r.length > 0), cabinetNavRow()],
    pd: false,
  };
}

function storefrontWords(t: ChatTour): string {
  if (!t.isActive) return 'скрыт';
  if (!t.isPublished) return 'черновик — туристы не видят';
  return 'на витрине';
}

export function priceWords(price: number | null, unit: string | null): string {
  if (price === null) return 'цена не записана';
  const u = unit ? PRICE_UNIT_LABELS[unit] : undefined;
  return u ? `${formatRub(price)} ${u}` : formatRub(price);
}

function base(url: string): string {
  return url.replace(/\/$/, '');
}

/** Образец фразы правки — с коротким именем тура гида. */
export function shortTourName(title: string): string {
  const words = title.replace(/[«»"]/g, '').split(/\s+/).filter((w) => w.length >= 4 && /^[А-ЯЁA-Z]/.test(w));
  const pick = words.find((w) => !/^(Восхождение|Экскурсия|Тур|Поход|Сплав|Вулкан)$/i.test(w)) ?? words[0];
  return pick ?? clip(title, 20);
}

export const FORMAT_LINES = (name: string): string[] => [
  'Править текст тура — одним сообщением, тур и поле через двоеточие:',
  `• <code>${escapeHtml(name)}: описание: …</code>`,
  `• <code>${escapeHtml(name)}: анонс: …</code> — короткая строка под названием`,
  `• <code>${escapeHtml(name)}: цена 16000</code>`,
  `• <code>${escapeHtml(name)}: программа:</code> и шаги с новой строки: «1. Дорога: выезд в 7:00…»`,
  `• <code>${escapeHtml(name)}: что взять: ботинки, куртка, перчатки</code>`,
  '• ещё поля: название, что включено, не входит, безопасность.',
  'Я покажу, что было и что станет, — запишется только после кнопки «Сохранить».',
];

// ── Мои туры ────────────────────────────────────────────────────────────────

export function myToursScreen(tours: readonly ChatTour[], siteBase: string, notice?: string | null): CabinetScreen {
  if (tours.length === 0) {
    return screen([notice ?? null, '<b>Мои туры</b>', `Своих туров в кабинете нет. Раздел на сайте: ${base(siteBase)}${GUIDE_OWN_PATH}`], []);
  }
  const lines: string[] = [];
  if (notice) lines.push(notice);
  lines.push('<b>Мои туры</b>');
  for (const t of tours) lines.push(`• ${escapeHtml(t.title)} — ${storefrontWords(t)} · ${priceWords(t.basePrice, t.priceUnit)}`);
  lines.push('Нажмите тур: даты, правка текста и цены, страница на сайте.');
  return screen(lines, tours.slice(0, 12).map((t) => [{ text: buttonText(t.title), payload: cabinetPayload.tour(t.id) }]));
}

function filled(t: ChatTour, f: EditField): string {
  const v = t.fields[f];
  if (v === null || v === undefined) return 'не записано';
  if (typeof v === 'string') return `${v.length} знаков`;
  if (Array.isArray(v)) return f === 'program' ? `шагов: ${v.length}` : `пунктов: ${v.length}`;
  return 'есть';
}

export function tourScreen(t: ChatTour, siteBase: string, notice?: string | null): CabinetScreen {
  const lines: string[] = [];
  if (notice) lines.push(notice);
  lines.push(
    `<b>${escapeHtml(t.title)}</b>`,
    `Состояние: ${storefrontWords(t)}. Цена: ${priceWords(t.basePrice, t.priceUnit)}.`,
    `Группа: ${t.maxParticipants === null ? 'не записана' : `до ${t.maxParticipants} чел.`}`,
    `Анонс — ${filled(t, 'short_description')}; описание — ${filled(t, 'description')}; программа — ${filled(t, 'program')}.`,
    `Что включено — ${filled(t, 'included')}; не входит — ${filled(t, 'not_included')}; что взять — ${filled(t, 'what_to_bring')}; безопасность — ${filled(t, 'safety_notes')}.`,
  );
  const rows: CabinetButton[][] = [
    [{ text: 'Даты', payload: cabinetPayload.tourDates(t.id) }, { text: 'Править текст', payload: cabinetPayload.tourHint(t.id) }],
  ];
  if (t.isActive && t.isPublished) rows.push([{ text: 'Страница тура', url: `${base(siteBase)}${tourPath({ id: t.id, slug: t.slug })}` }]);
  rows.push([{ text: '‹ Мои туры', payload: cabinetPayload.myTours() }]);
  return screen(lines, rows);
}

export function hintScreen(t: ChatTour): CabinetScreen {
  return screen(
    [
      `<b>${escapeHtml(t.title)}</b> — правка текста`, ...FORMAT_LINES(shortTourName(t.title)),
      'Весь текст тура сразу — документом Word (.docx) в диалог с ботом в MAX: разложу по полям и покажу, что было и что станет.',
    ],
    [[{ text: '‹ Тур', payload: cabinetPayload.tour(t.id) }]],
  );
}

// ── Предпросмотр правки ─────────────────────────────────────────────────────

const PREVIEW_LIVE_MAX = 700;
const PREVIEW_NEW_MAX = 2200;
const PREVIEW_STEP_MAX = 300;

function renderValue(field: EditField, v: unknown, max: number, unit: string | null): { text: string; clipped: boolean } {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return { text: '<i>не записано</i>', clipped: false };
  if (field === 'base_price') return { text: priceWords(typeof v === 'number' ? v : Number(v), unit), clipped: false };
  let clipped = false;
  let out: string;
  if (field === 'program' && Array.isArray(v)) {
    out = (v as TourProgramStep[]).map((s, i) => {
      const text = s.text ?? '';
      if (text.length > PREVIEW_STEP_MAX) clipped = true;
      return `${i + 1}. <b>${escapeHtml(s.title)}</b>${text ? ` — ${escapeHtml(clip(text, PREVIEW_STEP_MAX))}` : ''}`;
    }).join('\n');
  } else if (Array.isArray(v)) {
    out = v.map((x) => `• ${escapeHtml(String(x))}`).join('\n');
  } else {
    const s = String(v);
    if (s.length > max) clipped = true;
    return { text: escapeHtml(clip(s, max)), clipped };
  }
  if (out.length > max) {
    // Режем по строкам: обрезанная HTML-сущность сломала бы сообщение.
    const keep: string[] = [];
    let len = 0;
    for (const line of out.split('\n')) {
      if (len + line.length > max) break;
      keep.push(line);
      len += line.length + 1;
    }
    return { text: `${keep.join('\n')}\n…`, clipped: true };
  }
  return { text: out, clipped };
}

export function previewScreen(args: {
  draftId: string;
  tour: ChatTour;
  field: EditField;
  newValue: EditValue;
  liveValue: unknown;
  /** Тур поменяли после прежнего предпросмотра — сказать это сверху. */
  changedNotice?: boolean;
}): CabinetScreen {
  const { tour, field } = args;
  const lines: string[] = [];
  if (args.changedNotice) {
    lines.push('Пока черновик ждал, это поле тура изменили (на сайте или другой кнопкой). Ничего не записал — вот что в нём сейчас.');
  }
  lines.push(`<b>${escapeHtml(tour.title)}</b> — ${FIELD_LABEL[field]}`);
  if (field === 'base_price') {
    lines.push(`Было: ${priceWords(typeof args.liveValue === 'number' ? args.liveValue : null, tour.priceUnit)}`);
    lines.push(`Станет: <b>${priceWords(Number(args.newValue), tour.priceUnit)}</b>`);
    lines.push('Цена на уже записанные брони не меняется — только для новых.');
  } else {
    const was = renderValue(field, args.liveValue, PREVIEW_LIVE_MAX, tour.priceUnit);
    const next = renderValue(field, args.newValue, PREVIEW_NEW_MAX, tour.priceUnit);
    lines.push('<b>Было:</b>', was.text, '', '<b>Станет:</b>', next.text);
    if (was.clipped || next.clipped) lines.push('(Здесь сокращено для чата — сохранится полностью.)');
  }
  lines.push('', `Ничего не записано, пока вы не нажмёте «Сохранить». После него — сразу на сайте. Черновик ждёт ${DRAFT_TTL_HOURS} часа.`);
  return screen(lines, [[
    { text: 'Сохранить', payload: cabinetPayload.editSave(args.draftId), intent: 'positive' },
    { text: 'Отмена', payload: cabinetPayload.editCancel(args.draftId), intent: 'negative' },
  ]]);
}

export function chooseTourScreen(draftId: string, field: EditField, tours: readonly ChatTour[], words: string | null): CabinetScreen {
  const lines = [
    words ? `«${escapeHtml(words)}» — подходит несколько ваших туров.` : 'Тур в сообщении не назван.',
    `Какой тур правим (${FIELD_LABEL[field].toLowerCase()})? Нажмите — покажу, что было и что станет.`,
  ];
  if (tours.length > CHOOSE_MAX) lines.push(`Показаны первые ${CHOOSE_MAX}. Другой — назовите точнее перед двоеточием.`);
  return screen(lines, [
    ...tours.slice(0, CHOOSE_MAX).map((t, i) => [{ text: buttonText(t.title), payload: cabinetPayload.editTour(draftId, i) }]),
    [{ text: 'Отмена', payload: cabinetPayload.editCancel(draftId), intent: 'negative' as const }],
  ]);
}

export function savedScreen(args: { field: EditField; title: string; tourId: string; slug: string | null; siteBase: string; published: boolean }): CabinetScreen {
  const url = `${base(args.siteBase)}${tourPath({ id: args.tourId, slug: args.slug })}`;
  return screen([
    `Сохранено: ${FIELD_LABEL[args.field].toLowerCase()} тура «${escapeHtml(args.title)}».`,
    args.published ? `На сайте — сразу: ${url}` : 'Тур не на витрине: туристы увидят правку, когда он будет опубликован.',
  ], [[{ text: 'К туру', payload: cabinetPayload.tour(args.tourId) }, { text: '‹ Мои туры', payload: cabinetPayload.myTours() }]]);
}

export const EDIT_TEXT = {
  noAccount: 'Править тур из чата может карточка с кабинетом на сайте. Ничего не записал.',
  toursFailed: 'Туры не прочитались — база не ответила. Это не «туров нет». Ничего не записал, попробуйте ещё раз.',
  draftFailed: 'Черновик правки не записался — база не ответила. В туре ничего не изменено, попробуйте ещё раз.',
  saveFailed: 'Не сохранилось — база не ответила. В туре ничего не изменено, нажмите «Сохранить» ещё раз.',
  notFound: 'Этот черновик не найден в этом чате — в туре ничего не изменено.',
  savedBefore: 'Эта правка уже сохранена.',
  cancelledBefore: 'Эту правку уже отменили — в туре ничего не изменено.',
  superseded: 'Эту правку заменило ваше следующее сообщение — сохраняется только последняя. В туре ничего не изменено.',
  expired: `Черновик ждал больше ${DRAFT_TTL_HOURS} часов и устарел. В туре ничего не изменено — пришлите правку ещё раз.`,
  cancelled: 'Отменено. В туре ничего не изменено.',
  needTour: 'Сначала выберите тур кнопкой выше.',
  tourGone: 'Тур удалён или больше не ваш — ничего не записал.',
  staleButton: 'Кнопка устарела — пришлите правку ещё раз.',
  sameValue: 'Это ровно то, что уже записано в туре, — сохранять нечего.',
  notGuide: 'Туры в чате правит гид со своими турами. Ничего не записал.',
  tourNotFound: 'Тур не найден среди ваших.',
} as const;

export function rejectText(field: EditField, r: EditReject): string {
  const name = FIELD_LABEL[field];
  switch (r.reason) {
    case 'empty': return `${name}: после двоеточия пусто. Ничего не записал.`;
    case 'too_short': return `${name}: нужно хотя бы ${r.max} знаков. Ничего не записал.`;
    case 'too_long': return `${name}: ${r.got} знаков, а помещается ${r.max}. Сократите — ничего не записал.`;
    case 'bad_price': return 'Цена — одним числом в рублях: «цена 16000» или «цена 16 000». Ничего не записал.';
    case 'price_range': return `Цена — от ${formatRub(LIMITS.priceMin)} до ${formatRub(LIMITS.priceMax)}. Ничего не записал.`;
    case 'too_many': return `${name}: ${r.got} пунктов, а помещается ${r.max}. Ничего не записал.`;
    case 'item_too_long': return `${name}: пункт ${r.index} длиннее ${r.max} знаков. Ничего не записал.`;
    case 'step_no_title': return `${name}: у шага ${r.index} нет заголовка. Пишите «Заголовок: текст» — ничего не записал.`;
  }
}

export function noticeWithTours(text: string, tours: readonly ChatTour[] | null): CabinetScreen {
  const lines = [text];
  if (tours && tours.length) {
    lines.push('Ваши туры:', ...tours.slice(0, 12).map((t) => `• ${escapeHtml(t.title)}`));
    lines.push(...FORMAT_LINES(shortTourName(tours[0]!.title)));
  }
  return screen(lines, [[{ text: 'Мои туры', payload: cabinetPayload.myTours() }]]);
}

// ── Даты ────────────────────────────────────────────────────────────────────

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

export function datesScreen(args: { tour: ChatTour; days: readonly TourDay[]; page: number; notice?: string | null }): CabinetScreen {
  const { tour, days, page } = args;
  const lines: string[] = [];
  if (args.notice) lines.push(args.notice);
  lines.push(`<b>${escapeHtml(tour.title)}</b> — даты`);
  const buttons: CabinetButton[] = [];
  for (const d of days) {
    const day = `${ruShort(d.date)} ${weekday(d.date)}`;
    const open = d.slots !== null && !d.closed && d.slots > 0;
    let state: string;
    if (open) state = `открыта: мест ${d.slots}${d.taken > 0 ? `, записано ${d.taken}` : ''}`;
    else if (d.closed) state = `закрыта${d.taken > 0 ? `, записано ${d.taken}` : ''}`;
    else state = 'не открыта';
    lines.push(`• ${day} — ${state}`);
    if (open) buttons.push({ text: `Закрыть ${ruShort(d.date)}`, payload: cabinetPayload.dateClose(tour.id, d.date) });
    else if (tour.maxParticipants !== null && tour.maxParticipants > 0) {
      buttons.push({ text: `Открыть ${ruShort(d.date)}`, payload: cabinetPayload.dateOpen(tour.id, d.date) });
    }
  }
  if (tour.maxParticipants !== null && tour.maxParticipants > 0) {
    lines.push(`«Открыть» — на всю группу, ${tour.maxParticipants} мест. Другое число — фразой «открой 5 августа, 4 места» (в MAX).`);
  } else {
    lines.push('Размер группы у тура не записан — открыть дату кнопкой нечем. Фразой «открой 5 августа, 4 места» — в MAX.');
  }
  lines.push('Закрытие снимает дату с продажи; брони на неё не отменяются.');
  const rows: CabinetButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  const nav: CabinetButton[] = [];
  if (page > 0) nav.push({ text: '‹ Раньше', payload: cabinetPayload.tourDates(tour.id, page - 1) });
  if (page < TOUR_DATES_MAX_PAGE) nav.push({ text: 'Позже ›', payload: cabinetPayload.tourDates(tour.id, page + 1) });
  rows.push(nav);
  rows.push([{ text: '‹ Тур', payload: cabinetPayload.tour(tour.id) }]);
  return screen(lines, rows);
}
