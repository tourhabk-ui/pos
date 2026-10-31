/**
 * Экраны нового тура гида в чате кабинета (31.10) — тексты и кнопки, без
 * базы. Персональных данных нет: название, цена и текст тура. Всё, что ввёл
 * человек, экранируется: HTML разбирает мессенджер.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { cabinetNavRow, type CabinetButton, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import { cabinetPayload } from '@/lib/chat-cabinet/payload';
import type { OwnTourDraftInput } from '@/lib/guides/own-tour-create';
import { publishBlockerLabel } from '@/lib/guides/own-tour-words';
import { FIELD_LABEL, type EditField } from './parse';
import { CREATE_FIELD_LABEL, type CreateField, type CreateSpecs } from './create-parse';
import { NEW_TOUR_LINES, priceWords } from './screens';
import { DRAFT_TTL_HOURS } from './store';

const EXCERPT = 600;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function screen(lines: Array<string | null | undefined>, rows: CabinetButton[][]): CabinetScreen {
  return {
    text: lines.filter((l): l is string => typeof l === 'string').join('\n'),
    rows: [...rows.filter((r) => r.length > 0), cabinetNavRow()],
    pd: false,
  };
}

function groupWords(n: number): string {
  return `до ${n} чел.`;
}

const LIST_FIELDS: ReadonlyArray<Exclude<EditField, 'title' | 'short_description' | 'description' | 'base_price'>> = [
  'program', 'included', 'not_included', 'what_to_bring', 'safety_notes',
];

/** Предпросмотр нового тура: что получится, кнопки «Создать черновик» / «Отмена». */
export function createPreviewScreen(args: {
  draftId: string;
  values: OwnTourDraftInput;
  /** Для документа: тур из него не нашёлся среди своих — сказать это сверху. */
  notice?: string | null;
  /** Что из документа не легло (с причиной) — тур создаётся без этого. */
  skipped?: readonly string[];
}): CabinetScreen {
  const v = args.values;
  const lines: Array<string | null> = [
    args.notice ?? null,
    '<b>Новый тур — черновик</b>',
    `Название: <b>${escapeHtml(v.title)}</b>`,
    `Цена: ${priceWords(v.base_price, v.price_unit ?? 'per_person')}. Группа: ${groupWords(v.max_participants)}.`,
    `Описание: ${escapeHtml(clip(v.description, EXCERPT))}`,
  ];
  for (const f of LIST_FIELDS) {
    const val = v[f];
    if (!val || val.length === 0) continue;
    lines.push(`${FIELD_LABEL[f]}: ${f === 'program' ? `шагов ${val.length}` : `пунктов ${val.length}`}.`);
  }
  for (const s of args.skipped ?? []) lines.push(`• ${s}`);
  lines.push(
    '',
    `Ничего не создано, пока вы не нажмёте «Создать черновик». Черновик туристы не видят: на сайт — кнопкой «Опубликовать» у тура. Ждёт ${DRAFT_TTL_HOURS} часа.`,
  );
  return screen(lines, [[
    { text: 'Создать черновик', payload: cabinetPayload.createSave(args.draftId), intent: 'positive' },
    { text: 'Отмена', payload: cabinetPayload.createCancel(args.draftId), intent: 'negative' },
  ]]);
}

/** Чего не хватает во фразе или подписи — ничего не заведено. */
export function createIncompleteScreen(args: {
  missing: readonly CreateField[];
  problems: readonly string[];
  specs: CreateSpecs;
  head?: string | null;
  /** Как дописать: для документа — подписью к файлу. */
  fix?: string | null;
}): CabinetScreen {
  const lines: Array<string | null> = [args.head ?? null, '<b>Новый тур не создан</b> — ничего не записал.'];
  if (args.missing.length > 0) lines.push(`Не хватает: ${args.missing.map((f) => CREATE_FIELD_LABEL[f]).join(', ')}.`);
  for (const p of args.problems) lines.push(`• ${escapeHtml(p)}`);
  const got: string[] = [];
  if (args.specs.title) got.push(`название «${escapeHtml(clip(args.specs.title, 80))}»`);
  if (args.specs.base_price !== undefined) got.push(`цена ${priceWords(args.specs.base_price, args.specs.price_unit ?? 'per_person')}`);
  if (args.specs.max_participants !== undefined) got.push(`группа ${groupWords(args.specs.max_participants)}`);
  if (args.specs.description) got.push(`описание (${args.specs.description.length} знаков)`);
  if (got.length > 0) lines.push(`Понял: ${got.join(', ')}.`);
  lines.push(...(args.fix ? [args.fix] : NEW_TOUR_LINES));
  return screen(lines, [[{ text: 'Мои туры', payload: cabinetPayload.myTours() }]]);
}

/** Тур создан черновиком — дальше гейт тура: опубликовать или чего не хватает. */
export function createdScreen(args: { tourId: string; title: string; blockers: readonly string[] | null }): CabinetScreen {
  const lines = [`Создан черновик тура «${escapeHtml(args.title)}». Туристы его пока не видят.`];
  const rows: CabinetButton[][] = [];
  if (args.blockers === null) {
    lines.push('Чего не хватает до сайта — не проверилось: база не ответила. Откройте тур — кнопка «Опубликовать» проверит сама.');
  } else if (args.blockers.length > 0) {
    lines.push('До сайта не хватает:', ...args.blockers.map((b) => `• ${escapeHtml(publishBlockerLabel(b))}`));
  } else {
    lines.push('До сайта всего хватает. Можно дописать программу, что включено и что взять — фразой «<тур>: программа: …», — или опубликовать сразу.');
    rows.push([{ text: 'Опубликовать', payload: cabinetPayload.tourPublish(args.tourId), intent: 'positive' }]);
  }
  rows.push([{ text: 'К туру', payload: cabinetPayload.tour(args.tourId) }, { text: '‹ Мои туры', payload: cabinetPayload.myTours() }]);
  return screen(lines, rows);
}

export const CREATE_TEXT = {
  draftFailed: 'Черновик нового тура не записался — база не ответила. Ничего не создано, пришлите ещё раз.',
  saveFailed: 'Тур не создан — база не ответила. Ничего не записано, нажмите «Создать черновик» ещё раз.',
  notFound: 'Этот черновик нового тура не найден в этом чате — ничего не создано.',
  cancelledBefore: 'Этот новый тур уже отменили — ничего не создано.',
  superseded: 'Этот новый тур заменило ваше следующее действие — ничего не создано. Пришлите его ещё раз.',
  expired: `Черновик ждал больше ${DRAFT_TTL_HOURS} часов и устарел. Ничего не создано — пришлите ещё раз.`,
  cancelled: 'Отменено. Тур не создан.',
  invalid: 'Поля черновика не прошли проверку — тур не создан. Пришлите фразу ещё раз.',
  notGuide: 'Создавать туры из чата может гид со своей карточкой. Ничего не создано.',
  noAccount: 'Создать тур из чата может карточка с кабинетом на сайте. Ничего не создано.',
} as const;
