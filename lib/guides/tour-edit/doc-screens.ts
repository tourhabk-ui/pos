/**
 * Экраны документа гида (.docx → поля тура) — тексты и кнопки, без базы.
 * Персональных данных нет: текст тура. Всё, что пришло из документа,
 * экранируется: HTML разбирает мессенджер.
 *
 * Сообщение MAX ограничено по длине, поэтому предпросмотр — по полю строкой:
 * было и станет коротко (начало и объём), полностью — на сайте после записи.
 * Поле, которое записать нельзя, названо с причиной.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { cabinetNavRow, type CabinetButton, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import { cabinetPayload } from '@/lib/chat-cabinet/payload';
import type { TourProgramStep } from '@/lib/tours/tour-write';
import { FIELD_LABEL, type EditReject } from './parse';
import { DOC_FIELDS, type DocField } from './doc-sections';
import { docFieldsOf, type DocDraft } from './doc-store';
import { rejectText, CHOOSE_MAX } from './screens';
import { DRAFT_TTL_HOURS, type ChatTour } from './store';

const EXCERPT = 160;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function screen(lines: Array<string | null | undefined>, rows: CabinetButton[][]): CabinetScreen {
  return {
    text: lines.filter((l): l is string => typeof l === 'string').join('\n'),
    rows: [...rows.filter((r) => r.length > 0), cabinetNavRow()],
    pd: false,
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** Коротко о значении поля: объём и начало. */
export function valueGist(field: DocField, v: unknown): string {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return 'пусто';
  if (field === 'program' && Array.isArray(v)) {
    const steps = v as TourProgramStep[];
    return `${plural(steps.length, 'шаг', 'шага', 'шагов')}: ${escapeHtml(clip(steps.map((s) => s.title).join('; '), EXCERPT))}`;
  }
  if (Array.isArray(v)) return `${plural(v.length, 'пункт', 'пункта', 'пунктов')}: ${escapeHtml(clip(v.map(String).join(' · '), EXCERPT))}`;
  const s = String(v);
  return `${plural(s.length, 'знак', 'знака', 'знаков')}: «${escapeHtml(clip(s, EXCERPT))}»`;
}

export function docPreviewScreen(args: {
  draft: DocDraft;
  tour: ChatTour;
  rejects: ReadonlyArray<{ field: DocField; reject: EditReject }>;
  skipped: readonly string[];
  notice?: string | null;
}): CabinetScreen {
  const { draft, tour } = args;
  const lines: Array<string | null> = [args.notice ?? null, `<b>Документ → тур «${escapeHtml(tour.title)}»</b>`];
  const fields = docFieldsOf(draft.values);
  const pending = fields.filter((f) => !draft.saved.includes(f));
  for (const f of fields) {
    const label = FIELD_LABEL[f];
    if (draft.saved.includes(f)) {
      lines.push(`• ${label} — сохранено.`);
      continue;
    }
    lines.push(`• <b>${label}</b>\n  было: ${valueGist(f, draft.live?.[f] ?? null)}\n  станет: ${valueGist(f, draft.values[f])}`);
  }
  for (const r of args.rejects) lines.push(`• ${escapeHtml(rejectText(r.field, r.reject)).replace('Ничего не записал.', 'Это поле не запишу — поправьте в документе или пришлите фразой.')}`);
  for (const s of args.skipped) lines.push(`• Подзаголовок «${escapeHtml(clip(s, 80))}» — не записываю: название и анонс правятся фразой.`);
  const rows: CabinetButton[][] = [];
  if (pending.length > 0) {
    lines.push('', `Ничего не записано, пока вы не нажмёте кнопку. «Сохранить всё» — все поля выше, или по одному. После записи — сразу на сайте. Черновик ждёт ${DRAFT_TTL_HOURS} часа.`);
    rows.push([{ text: `Сохранить всё (${pending.length})`, payload: cabinetPayload.docSaveAll(draft.id), intent: 'positive' }]);
    const one = pending.map((f) => ({ text: `Сохранить: ${FIELD_LABEL[f]}`, payload: cabinetPayload.docSaveField(draft.id, DOC_FIELDS.indexOf(f)) }));
    for (let i = 0; i < one.length; i += 2) rows.push(one.slice(i, i + 2));
    rows.push([{ text: 'Отмена', payload: cabinetPayload.docCancel(draft.id), intent: 'negative' }]);
  } else {
    lines.push('', 'Всё из документа записано.');
  }
  rows.push([{ text: 'К туру', payload: cabinetPayload.tour(tour.id) }]);
  return screen(lines, rows);
}

export function docChooseTourScreen(draftId: string, tours: readonly ChatTour[], words: string | null): CabinetScreen {
  const lines = [
    words ? `Документ «${escapeHtml(words)}» — подходит несколько ваших туров.` : 'В документе нет первой строки с названием тура в «ёлочках».',
    'Какой тур заполнить? Нажмите — покажу по каждому полю, что было и что станет.',
  ];
  if (tours.length > CHOOSE_MAX) lines.push(`Показаны первые ${CHOOSE_MAX}.`);
  return screen(lines, [
    ...tours.slice(0, CHOOSE_MAX).map((t, i) => [{ text: clip(t.title, 40), payload: cabinetPayload.docTour(draftId, i) }]),
    [{ text: 'Отмена', payload: cabinetPayload.docCancel(draftId), intent: 'negative' as const }],
  ]);
}

export const DOC_TEXT = {
  notDocx: 'Это не документ Word (.docx) — разобрать не могу. Пришлите файл .docx или правку фразой «Горелый: описание: …». Ничего не записал.',
  tooBig: 'Файл больше 2 МБ — это не текст тура. Ничего не записал.',
  broken: 'Документ не открылся — файл повреждён. Ничего не записал.',
  downloadFailed: 'Файл не скачался из MAX. Ничего не записал — пришлите ещё раз.',
  nothing: 'В документе не нашёл ни одного раздела тура: описание, «Программа…», «Что взять с собой», «В стоимость включено», «Важно знать». Ничего не записал.',
  saveFailed: 'Не сохранилось — база не ответила. В туре ничего не изменено, нажмите ещё раз.',
  notFound: 'Этот документ не найден в этом чате — в туре ничего не изменено.',
  savedBefore: 'Всё из этого документа уже записано.',
  cancelledBefore: 'Этот документ уже отменили — в туре ничего не изменено.',
  superseded: 'Этот документ заменило ваше следующее действие — записывается только последнее. В туре ничего не изменено.',
  expired: `Черновик документа ждал больше ${DRAFT_TTL_HOURS} часов и устарел. В туре ничего не изменено — пришлите файл ещё раз.`,
  cancelled: 'Отменено. В туре ничего не изменено.',
  needTour: 'Сначала выберите тур кнопкой выше.',
  tourGone: 'Тур удалён или больше не ваш — ничего не записал.',
  staleButton: 'Кнопка устарела — пришлите документ ещё раз.',
  nothingLeft: 'Это поле уже записано.',
  sameAll: 'Всё в документе ровно как в туре сейчас — записывать нечего.',
} as const;
