/**
 * Документ гида (.docx) в личном диалоге MAX → поля своего тура (слово
 * владельца 30.10: «гид должен полностью управлять своей ролью из MAX»).
 *
 * Гид присылает файл — тот же документ, что правил в Word/Google-документах.
 * Файл разбирается правилами (lib/docs/docx-text, ./doc-sections): тур — по
 * первой строке «…» или подписи к файлу среди СВОИХ (неоднозначно — выбор
 * кнопкой), поля — по заголовкам разделов. Ответ — по каждому полю «было →
 * станет», кнопки «Сохранить всё», «Сохранить: поле», «Отмена». Без кнопки в
 * тур не пишется ничего; запись — общей функцией сайта (./doc-store).
 * Модель документ не видит и в тур не пишет.
 *
 * Кто вправе — как у правки фразой (./flow): гид со своими турами, карточка
 * этого чата, с кабинетом; личный диалог и заверенность апдейта проверяет
 * вебхук. Файл не хранится нигде: разобрали — и забыли.
 */

import type { PartnerChatContext } from '@/lib/kuzmich/operator-chat';
import { escapeHtml } from '@/lib/text/escape-html';
import { failedScreen, noticeScreen, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import type { CabinetPress } from '@/lib/chat-cabinet/payload';
import { docxParagraphs } from '@/lib/docs/docx-text';
import { editsOwnTours } from './flow';
import { pickTour } from './parse';
import { DOC_FIELDS, docSections } from './doc-sections';
import {
  cancelDocDraft, chooseDocTour, createDocDraft, docFieldsOf, saveDocDraft, type DocBlocked, type DocValues,
} from './doc-store';
import { DOC_TEXT, docChooseTourScreen, docPreviewScreen } from './doc-screens';
import { CHOOSE_MAX, EDIT_TEXT, noticeWithTours, rejectText } from './screens';
import { readEditTours, sameValue, type ChatTour, type EditChannel } from './store';

/** Имя файла — .docx: остальные файлы идут прежним путём. */
export function isDocxName(name: string | null | undefined): boolean {
  return typeof name === 'string' && /\.docx$/i.test(name.trim());
}

/**
 * Файл гида в личном диалоге. `null` — не этот случай (не гид со своими
 * турами или не .docx): файл идёт дальше прежним путём. `bytes` null — файл
 * не скачался (причину пишет вебхук).
 */
export async function captureGuideTourDoc(input: {
  channel: EditChannel;
  chatId: number;
  partner: PartnerChatContext;
  fileName: string | null;
  caption: string;
  /** null — не скачался; 'too_big' — больше предела, не качали. */
  bytes: Buffer | null | 'too_big';
}): Promise<CabinetScreen | null> {
  const { partner } = input;
  if (!editsOwnTours(partner) || !isDocxName(input.fileName)) return null;
  if (!partner.userId) return noticeScreen(EDIT_TEXT.noAccount);
  if (input.bytes === 'too_big') return noticeScreen(DOC_TEXT.tooBig);
  if (!input.bytes) return failedScreen(DOC_TEXT.downloadFailed);
  const doc = docxParagraphs(input.bytes);
  if (!doc.ok) return noticeScreen(doc.reason === 'too_big' ? DOC_TEXT.tooBig : doc.reason === 'broken' ? DOC_TEXT.broken : DOC_TEXT.notDocx);
  const sections = docSections(doc.paragraphs);
  const rejectLines = sections.rejects.map((r) => escapeHtml(rejectText(r.field, r.reject)));
  if (docFieldsOf(sections.values).length === 0) {
    return noticeScreen(rejectLines.length > 0 ? ['Ни одно поле документа записать нельзя:', ...rejectLines].join('\n') : DOC_TEXT.nothing);
  }

  const own = await readEditTours(partner.partnerId);
  if (own.outcome === 'db_error') return failedScreen(EDIT_TEXT.toursFailed);
  const words = input.caption.trim() || sections.tourWords;
  const pick = pickTour(words, own.tours);
  if (pick.kind === 'missing') {
    const head = words ? `Тур «${words}» не нашёл среди ваших. Ничего не записал. Подпишите файл названием тура.` : EDIT_TEXT.tourNotFound;
    return noticeWithTours(escapeHtml(head), own.tours);
  }
  if (pick.kind === 'choose') {
    const candidates = pick.tours.slice(0, CHOOSE_MAX) as ChatTour[];
    const d = await createDocDraft({
      partnerId: partner.partnerId, channel: input.channel, chatId: input.chatId, tour: null,
      candidateIds: candidates.map((t) => t.id), values: sections.values,
    });
    if (d.outcome !== 'created') return failedScreen(EDIT_TEXT.draftFailed);
    return docChooseTourScreen(d.id, pick.tours as ChatTour[], words);
  }
  const tour = pick.tour as ChatTour;
  // Поля, где документ говорит ровно то же, что тур, — не правка.
  const values: DocValues = {};
  for (const f of docFieldsOf(sections.values)) {
    if (!sameValue(tour.fields[f] ?? null, sections.values[f])) values[f] = sections.values[f];
  }
  if (docFieldsOf(values).length === 0) {
    return noticeScreen([DOC_TEXT.sameAll, ...rejectLines].join('\n'));
  }
  const d = await createDocDraft({
    partnerId: partner.partnerId, channel: input.channel, chatId: input.chatId, tour, candidateIds: [], values,
  });
  if (d.outcome !== 'created') return failedScreen(EDIT_TEXT.draftFailed);
  return docPreviewScreen({
    draft: {
      id: d.id, tourId: tour.id, candidateIds: [], values, saved: [],
      live: Object.fromEntries(docFieldsOf(values).map((f) => [f, tour.fields[f] ?? null])),
    },
    tour, rejects: sections.rejects, skipped: sections.skipped,
  });
}

function blockedText(b: DocBlocked): string {
  switch (b.kind) {
    case 'not_found': return DOC_TEXT.notFound;
    case 'saved_before': return DOC_TEXT.savedBefore;
    case 'cancelled_before': return DOC_TEXT.cancelledBefore;
    case 'superseded': return DOC_TEXT.superseded;
    case 'expired': return DOC_TEXT.expired;
    case 'db_error': return DOC_TEXT.saveFailed;
  }
}

type DocPress = Extract<CabinetPress, { kind: 'doc_save' | 'doc_cancel' | 'doc_tour' }>;

/** Кнопка документа. Чат и карточку проверил сервис кабинета; здесь — роль и владение. */
export async function guideDocPress(press: DocPress, who: {
  partner: Pick<PartnerChatContext, 'partnerId' | 'userId' | 'category' | 'sellsTours'>;
  owner: boolean;
  channel: EditChannel;
  chatId: number;
}): Promise<CabinetScreen> {
  const { partner } = who;
  if (!who.owner || !editsOwnTours(partner)) return noticeScreen(EDIT_TEXT.notGuide);
  if (!partner.userId) return noticeScreen(EDIT_TEXT.noAccount);
  const w = { partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId };
  switch (press.kind) {
    case 'doc_cancel': {
      const r = await cancelDocDraft(w);
      return noticeScreen(r.kind === 'cancelled' ? DOC_TEXT.cancelled : blockedText(r));
    }
    case 'doc_tour': {
      const r = await chooseDocTour(w, press.index);
      if (r.kind === 'stale_button') return noticeScreen(DOC_TEXT.staleButton);
      if (r.kind !== 'chosen') return r.kind === 'db_error' ? failedScreen(DOC_TEXT.saveFailed) : noticeScreen(blockedText(r));
      return docPreviewScreen({ draft: r.draft, tour: r.tour, rejects: [], skipped: [] });
    }
    case 'doc_save': {
      const field = press.field === null ? 'all' : DOC_FIELDS[press.field];
      if (field === undefined) return noticeScreen(DOC_TEXT.staleButton);
      const r = await saveDocDraft(w, field);
      switch (r.kind) {
        case 'saved': {
          const parts: string[] = [];
          if (r.written.length > 0) parts.push(`Сохранено: ${r.written.map((f) => fieldWord(f)).join(', ')}. На сайте — сразу.`);
          if (r.changed.length > 0) {
            parts.push(`Не записал: ${r.changed.map((f) => fieldWord(f)).join(', ')} — пока документ ждал, это поле тура изменили. Ниже — что в нём сейчас.`);
          }
          return docPreviewScreen({ draft: r.draft, tour: { ...r.tour, title: r.title }, rejects: [], skipped: [], notice: escapeHtml(parts.join('\n')) });
        }
        case 'nothing': return noticeScreen(DOC_TEXT.nothingLeft);
        case 'need_tour': return noticeScreen(DOC_TEXT.needTour);
        case 'tour_gone': return noticeScreen(DOC_TEXT.tourGone);
        case 'db_error': return failedScreen(DOC_TEXT.saveFailed);
        default: return noticeScreen(blockedText(r));
      }
    }
  }
}

const FIELD_WORDS: Readonly<Record<(typeof DOC_FIELDS)[number], string>> = {
  description: 'описание',
  program: 'программа',
  included: 'что включено',
  not_included: 'что не входит',
  what_to_bring: 'что взять с собой',
  safety_notes: 'безопасность',
};

function fieldWord(f: (typeof DOC_FIELDS)[number]): string {
  return FIELD_WORDS[f];
}
