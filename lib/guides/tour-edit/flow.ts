/**
 * Гид управляет своими турами из чата кабинета (слово владельца 30.10: «гид
 * должен полностью управлять своей ролью из MAX»). Повод — в тот же день
 * гид правил тексты своих туров в Google-документах, а разработчик переносил
 * их миграцией: правки текста тура у гида не было нигде.
 *
 * Две двери:
 *  - ТЕКСТ «Горелый: описание: …» (`captureGuideTourEdit`) — разбор правилами
 *    (lib/guides/tour-edit/parse), черновик (1357), ответ — «было → станет» и
 *    кнопки «Сохранить» / «Отмена». Модель фразу не видит и в тур не пишет:
 *    иначе она сказала бы «сохранил», ничего не сохранив;
 *  - КНОПКИ кабинета (`cb:u`, `cb:w`, `cb:h`, `cb:e`, `guideTourPress`) —
 *    «Мои туры» → тур → «Даты» (открыть и закрыть дату той же функцией, что
 *    раздел «Свои туры» на сайте, lib/guides/own-dates) и «Править текст».
 *
 * Запись тура — только кнопкой «Сохранить», общей функцией сайта
 * (`writeTourPatch`, lib/tours/tour-write). Модерации нет, как у правки
 * оператора на сайте: тур гида — гид и решает.
 *
 * Кто вправе: гид со своими турами (`sellsOwnTours`), карточка этого чата,
 * с кабинетом (`partners.user_id`), личный диалог (кнопку в группе нажал бы
 * любой). Права чата проверяет вызывающий (вебхук — заверенность апдейта,
 * сервис кабинета — чат и карточку); здесь — роль и владение туром.
 * Персональных данных в этих экранах нет — поэтому и Telegram.
 */

import type { PartnerChatContext } from '@/lib/kuzmich/operator-chat';
import { guideSellsOwnTours } from '@/lib/roles/role-menu';
import { escapeHtml } from '@/lib/text/escape-html';
import { getPublicBaseUrl } from '@/lib/config';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { failedScreen, noticeScreen, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import type { CabinetPress } from '@/lib/chat-cabinet/payload';
import { openGuideTourDates, closeGuideTourDates } from '@/lib/guides/own-dates';
import { tourHiddenText } from '@/lib/tours/availability-open';
import { parseTourEdit, pickTour } from './parse';
import {
  cancelDraft, chooseDraftTour, createDraft, readEditTour, readEditTours, readTourDays, sameValue, saveDraft,
  type ChatTour, type DraftBlocked, type EditChannel,
} from './store';
import {
  CHOOSE_MAX, DAYS_PER_PAGE, EDIT_TEXT, chooseTourScreen, datesScreen, hintScreen, myToursScreen, noticeWithTours,
  previewScreen, rejectText, savedScreen, tourScreen,
} from './screens';

/** Правит ли эта карточка свои туры из чата: гид со своими турами. */
export function editsOwnTours(p: Pick<PartnerChatContext, 'partnerId' | 'category' | 'sellsTours'>): boolean {
  return guideSellsOwnTours(p);
}

/**
 * Сообщение гида в личном диалоге. Не правка тура (другая форма фразы) или
 * не гид со своими турами — `null`: сообщение идёт дальше своим путём.
 */
export async function captureGuideTourEdit(input: {
  channel: EditChannel;
  chatId: number;
  partner: PartnerChatContext;
  text: string;
}): Promise<CabinetScreen | null> {
  const { partner } = input;
  if (!editsOwnTours(partner)) return null;
  const parsed = parseTourEdit(input.text);
  if (parsed === null) return null;
  if (!partner.userId) return noticeScreen(EDIT_TEXT.noAccount);
  if (!parsed.ok) return noticeWithTours(rejectText(parsed.field, parsed), null);

  const own = await readEditTours(partner.partnerId);
  if (own.outcome === 'db_error') return failedScreen(EDIT_TEXT.toursFailed);

  const { edit } = parsed;
  const pick = pickTour(edit.tourWords, own.tours);
  if (pick.kind === 'missing') {
    const head = edit.tourWords ? `Тур «${edit.tourWords}» не нашёл среди ваших. Ничего не записал.` : EDIT_TEXT.tourNotFound;
    return noticeWithTours(escapeHtml(head), own.tours);
  }
  if (pick.kind === 'choose') {
    const candidates = pick.tours.slice(0, CHOOSE_MAX) as ChatTour[];
    const draft = await createDraft({
      partnerId: partner.partnerId, channel: input.channel, chatId: input.chatId, tourId: null,
      candidateIds: candidates.map((t) => t.id), field: edit.field, newValue: edit.value, liveValue: null,
    });
    if (draft.outcome !== 'created') return failedScreen(EDIT_TEXT.draftFailed);
    return chooseTourScreen(draft.id, edit.field, pick.tours as ChatTour[], edit.tourWords);
  }
  const tour = pick.tour as ChatTour;
  const live = tour.fields[edit.field] ?? null;
  if (sameValue(live, edit.value)) return noticeScreen(EDIT_TEXT.sameValue);
  const draft = await createDraft({
    partnerId: partner.partnerId, channel: input.channel, chatId: input.chatId, tourId: tour.id,
    candidateIds: [], field: edit.field, newValue: edit.value, liveValue: live,
  });
  if (draft.outcome !== 'created') return failedScreen(EDIT_TEXT.draftFailed);
  return previewScreen({ draftId: draft.id, tour, field: edit.field, newValue: edit.value, liveValue: live });
}

function blockedText(b: DraftBlocked): string {
  switch (b.kind) {
    case 'not_found': return EDIT_TEXT.notFound;
    case 'saved_before': return EDIT_TEXT.savedBefore;
    case 'cancelled_before': return EDIT_TEXT.cancelledBefore;
    case 'superseded': return EDIT_TEXT.superseded;
    case 'expired': return EDIT_TEXT.expired;
    case 'db_error': return EDIT_TEXT.saveFailed;
  }
}

type TourPress = Extract<CabinetPress, {
  kind: 'my_tours' | 'tour' | 'tour_dates' | 'date_open' | 'date_close' | 'tour_hint' | 'edit_save' | 'edit_cancel' | 'edit_tour';
}>;

export const GUIDE_TOUR_PRESS_KINDS: ReadonlySet<CabinetPress['kind']> = new Set([
  'my_tours', 'tour', 'tour_dates', 'date_open', 'date_close', 'tour_hint', 'edit_save', 'edit_cancel', 'edit_tour',
]);

export function isGuideTourPress(p: CabinetPress): p is TourPress {
  return GUIDE_TOUR_PRESS_KINDS.has(p.kind);
}

/**
 * Кнопка «Моих туров». Чат и карточку проверил сервис кабинета; здесь —
 * что карточка правит свои туры и что тур её.
 */
export async function guideTourPress(press: TourPress, who: {
  partner: Pick<PartnerChatContext, 'partnerId' | 'userId' | 'category' | 'sellsTours'>;
  /** Владелец карточки, не менеджер команды. */
  owner: boolean;
  channel: EditChannel;
  chatId: number;
  nowMs: number;
}): Promise<CabinetScreen> {
  const { partner } = who;
  if (!who.owner || !editsOwnTours(partner)) return noticeScreen(EDIT_TEXT.notGuide);
  if (!partner.userId) return noticeScreen(EDIT_TEXT.noAccount);
  const site = getPublicBaseUrl();
  const today = kamchatkaDate(new Date(who.nowMs));

  switch (press.kind) {
    case 'my_tours': {
      const own = await readEditTours(partner.partnerId);
      return own.outcome === 'ok' ? myToursScreen(own.tours, site) : failedScreen(EDIT_TEXT.toursFailed);
    }
    case 'tour':
    case 'tour_hint': {
      const t = await readEditTour(partner.partnerId, press.tourId);
      if (t.outcome === 'db_error') return failedScreen(EDIT_TEXT.toursFailed);
      if (t.outcome === 'not_found') return toursWithNotice(partner.partnerId, EDIT_TEXT.tourNotFound);
      return press.kind === 'tour' ? tourScreen(t.tour, site) : hintScreen(t.tour);
    }
    case 'tour_dates':
      return datesPage(partner.partnerId, press.tourId, press.page, today);
    case 'date_open':
    case 'date_close':
      return dateToggle(partner.partnerId, press, today);
    case 'edit_cancel': {
      const r = await cancelDraft({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId });
      return noticeScreen(r.kind === 'cancelled' ? EDIT_TEXT.cancelled : blockedText(r));
    }
    case 'edit_tour': {
      const r = await chooseDraftTour({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId }, press.index);
      if (r.kind === 'stale_button') return noticeScreen(EDIT_TEXT.staleButton);
      if (r.kind !== 'chosen') return r.kind === 'db_error' ? failedScreen(EDIT_TEXT.saveFailed) : noticeScreen(blockedText(r));
      if (sameValue(r.draft.liveValue, r.draft.newValue)) {
        await cancelDraft({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId });
        return noticeScreen(EDIT_TEXT.sameValue);
      }
      return previewScreen({ draftId: r.draft.id, tour: r.tour, field: r.draft.field, newValue: r.draft.newValue, liveValue: r.draft.liveValue });
    }
    case 'edit_save': {
      const r = await saveDraft({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId });
      switch (r.kind) {
        case 'saved': {
          const t = await readEditTour(partner.partnerId, r.draft.tourId ?? '');
          const published = t.outcome === 'ok' ? t.tour.isActive && t.tour.isPublished : true;
          return savedScreen({ field: r.draft.field, title: r.title, tourId: r.draft.tourId ?? '', slug: r.slug, siteBase: site, published });
        }
        case 'changed':
          return previewScreen({
            draftId: r.draft.id, tour: r.tour, field: r.draft.field, newValue: r.draft.newValue, liveValue: r.draft.liveValue, changedNotice: true,
          });
        case 'need_tour': return noticeScreen(EDIT_TEXT.needTour);
        case 'tour_gone': return noticeScreen(EDIT_TEXT.tourGone);
        case 'db_error': return failedScreen(EDIT_TEXT.saveFailed);
        default: return noticeScreen(blockedText(r));
      }
    }
  }
}

async function toursWithNotice(partnerId: string, notice: string): Promise<CabinetScreen> {
  const own = await readEditTours(partnerId);
  return own.outcome === 'ok' ? myToursScreen(own.tours, getPublicBaseUrl(), notice) : failedScreen(EDIT_TEXT.toursFailed);
}

async function datesPage(partnerId: string, tourId: string, page: number, today: string, notice?: string): Promise<CabinetScreen> {
  const from = shiftDate(today, page * DAYS_PER_PAGE);
  const to = shiftDate(from, DAYS_PER_PAGE - 1);
  const r = await readTourDays(partnerId, tourId, from, to);
  if (r.outcome === 'db_error') return failedScreen(notice ? `${notice}\nДаты не прочитались — база не ответила.` : 'Даты не прочитались — база не ответила. Это не «дат нет».');
  if (r.outcome === 'not_found') return toursWithNotice(partnerId, EDIT_TEXT.tourNotFound);
  return datesScreen({ tour: r.tour, days: r.days, page, notice });
}

function pageOf(date: string, today: string): number {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return Math.max(0, Math.floor(days / DAYS_PER_PAGE));
}

const OPEN_WORDS: Readonly<Record<string, string>> = {
  opened: 'открыта',
  reopened: 'открыта снова',
  updated: 'уже была открыта — места переписаны',
  already_open: 'уже открыта',
  refused_booked: 'не открыта: записано больше мест, чем в группе',
  refused_closed: 'не открыта: закрыта',
  refused_past: 'не открыта: дата прошла',
  refused_horizon: 'не открыта: дальше года вперёд',
  refused_season: 'не открыта: вне сезона тура',
};

async function dateToggle(
  partnerId: string,
  press: Extract<CabinetPress, { kind: 'date_open' | 'date_close' }>,
  today: string,
): Promise<CabinetScreen> {
  const day = `${press.date.slice(8, 10)}.${press.date.slice(5, 7)}`;
  const page = Math.min(pageOf(press.date, today), 12);
  if (press.date < today) return datesPage(partnerId, press.tourId, 0, today, `${day}: дата прошла — ничего не изменил.`);
  if (press.kind === 'date_close') {
    const r = await closeGuideTourDates({ partnerId, tourId: press.tourId, dates: [press.date] });
    if (!r.ok && r.reason === 'tour_not_found') return toursWithNotice(partnerId, EDIT_TEXT.tourNotFound);
    if (!r.ok) return failedScreen(`${day}: не закрылась — база не ответила. Ничего не изменено.`);
    return datesPage(partnerId, press.tourId, page, today, `${day}: закрыта для продажи. Брони на неё не отменены.`);
  }
  const t = await readEditTour(partnerId, press.tourId);
  if (t.outcome === 'db_error') return failedScreen(EDIT_TEXT.toursFailed);
  if (t.outcome === 'not_found') return toursWithNotice(partnerId, EDIT_TEXT.tourNotFound);
  const seats = t.tour.maxParticipants;
  if (seats === null || seats <= 0) {
    return datesPage(partnerId, press.tourId, page, today, `${day}: размер группы у тура не записан — открыть кнопкой нечем.`);
  }
  const r = await openGuideTourDates({ partnerId, tourId: press.tourId, dates: [press.date], slots: seats, today });
  if (!r.ok) {
    if (r.reason === 'tour_not_found') return toursWithNotice(partnerId, EDIT_TEXT.tourNotFound);
    if (r.reason === 'tour_inactive') return datesPage(partnerId, press.tourId, page, today, escapeHtml(tourHiddenText(r.title)));
    return failedScreen(`${day}: не открылась — база не ответила. Ничего не изменено.`);
  }
  const result = r.perDate[0]?.result ?? 'refused_past';
  return datesPage(partnerId, press.tourId, page, today, `${day}: ${OPEN_WORDS[result] ?? result}${result === 'opened' || result === 'reopened' ? `, ${seats} мест` : ''}.`);
}
