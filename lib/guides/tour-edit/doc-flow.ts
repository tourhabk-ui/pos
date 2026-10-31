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
import type { TourProgramStep } from '@/lib/tours/tour-write';
import type { OwnTourDraftInput } from '@/lib/guides/own-tour-create';
import { createsOwnTours, editsOwnTours } from './flow';
import { parseFieldValue, pickTour } from './parse';
import { DOC_FIELDS, docSections, type DocSections } from './doc-sections';
import { finishCreate, parseCreateCaption, type CreateSpecs } from './create-parse';
import { createTourCreateDraft } from './create-store';
import { CREATE_TEXT, createIncompleteScreen, createPreviewScreen } from './create-screens';
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
  // Любой гид (31.10): документ, тура из которого нет среди своих, заводит
  // новый тур — и у гида без своих туров тоже.
  if (!createsOwnTours(partner) || !isDocxName(input.fileName)) return null;
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
  // Подпись может нести цену и группу нового тура («цена 15000; группа 4») —
  // тур среди своих ищется по остальным её словам или по первой строке.
  const caption = parseCreateCaption(input.caption);
  const words = caption.tourWords ?? sections.tourWords;
  const pick = pickTour(words, own.tours);
  if (pick.kind === 'missing') {
    return createFromDoc({ ...input, partner }, sections, caption, words, own.tours.length > 0);
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

/**
 * Тура из документа нет среди своих — предложить новый тур из него (31.10).
 * Название — первая строка «…» (или подпись), цена и группа — подпись к
 * файлу, описание и остальные поля — разделы документа. Чего нет — сказано,
 * ничего не заведено; всё есть — предпросмотр и «Создать черновик».
 */
async function createFromDoc(
  input: { channel: EditChannel; chatId: number; partner: PartnerChatContext },
  sections: DocSections,
  caption: ReturnType<typeof parseCreateCaption>,
  words: string | null,
  hasTours: boolean,
): Promise<CabinetScreen> {
  const head = [
    words
      ? `Тур «${escapeHtml(words)}» не нашёл среди ваших — в существующих турах ничего не записал. Можно создать из документа новый тур.`
      : 'Тур в документе не назван и среди ваших не найден — ничего не записал. Можно создать из документа новый тур.',
    hasTours ? 'Если документ — для вашего тура, подпишите файл его названием и пришлите ещё раз.' : null,
  ].filter((l): l is string => l !== null).join('\n');
  const specs: CreateSpecs = { ...caption.specs };
  const problems = [...caption.problems];
  if (sections.tourWords) {
    const t = parseFieldValue('title', sections.tourWords);
    if ('reason' in t) problems.push(rejectText('title', t).replace(' Ничего не записал.', ''));
    else specs.title = t.value as string;
  }
  const desc = sections.values.description;
  if (typeof desc === 'string') specs.description = desc;
  const done = finishCreate(specs, problems);
  if (done.kind !== 'ok') {
    const missing = done.kind === 'incomplete' ? done.missing : [];
    return createIncompleteScreen({
      head, missing, problems: done.kind === 'incomplete' ? done.problems : [], specs,
      fix: 'Название — первая строка документа в «ёлочках», описание — текст под ним; цену и группу напишите подписью к файлу: «цена 15000; группа 4» — и пришлите файл ещё раз.',
    });
  }
  const values: OwnTourDraftInput = { ...done.values };
  const v = sections.values;
  if (Array.isArray(v.program)) values.program = v.program as TourProgramStep[];
  for (const f of ['included', 'not_included', 'what_to_bring', 'safety_notes'] as const) {
    if (Array.isArray(v[f])) values[f] = v[f] as string[];
  }
  const d = await createTourCreateDraft({ partnerId: input.partner.partnerId, channel: input.channel, chatId: input.chatId, source: 'doc', values });
  if (d.outcome !== 'created') return failedScreen(CREATE_TEXT.draftFailed);
  const skipped = [
    ...sections.rejects.map((r) => `${escapeHtml(rejectText(r.field, r.reject)).replace('Ничего не записал.', 'Это поле не войдёт — поправьте в документе или допишите фразой.')}`),
    ...sections.skipped.map((s) => `Подзаголовок «${escapeHtml(s.length > 80 ? `${s.slice(0, 79)}…` : s)}» — не записываю: анонс правится фразой.`),
  ];
  return createPreviewScreen({ draftId: d.id, values, notice: head, skipped });
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
