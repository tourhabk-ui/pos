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
import { tourPath } from '@/lib/tours/tour-url';
import { readPublishGate, setOwnTourOnSite } from '@/lib/guides/own-tour-publish';
import { parseTourEdit, pickTour } from './parse';
import { parseTourCreate, type CreateParse } from './create-parse';
import {
  cancelTourCreateDraft, createTourCreateDraft, saveTourCreateDraft, type CancelCreate, type SaveCreate,
} from './create-store';
import { CREATE_TEXT, createdScreen, createIncompleteScreen, createPreviewScreen } from './create-screens';
import {
  cancelDraft, chooseDraftTour, createDraft, readEditTour, readEditTours, readTourDays, sameValue, saveDraft,
  type ChatTour, type DraftBlocked, type EditChannel,
} from './store';
import {
  CHOOSE_MAX, DAYS_PER_PAGE, EDIT_TEXT, chooseTourScreen, datesScreen, hintScreen, myToursScreen, newTourHintScreen,
  noticeWithTours, previewScreen, rejectText, savedScreen, tourScreen,
} from './screens';

/** Правит ли эта карточка свои туры из чата: гид со своими турами. */
export function editsOwnTours(p: Pick<PartnerChatContext, 'partnerId' | 'category' | 'sellsTours'>): boolean {
  return guideSellsOwnTours(p);
}

/**
 * Создаёт ли эта карточка свои туры из чата (31.10): любой гид — и тот, у кого
 * своих туров ещё нет: первый тур иначе завести было бы негде. Правка и даты —
 * по-прежнему у гида со своими турами (`editsOwnTours`).
 */
export function createsOwnTours(p: Pick<PartnerChatContext, 'category'>): boolean {
  return p.category === 'guide';
}

/**
 * Фраза «новый тур: …»: всё есть — черновик создания и предпросмотр с кнопкой
 * «Создать черновик»; чего-то нет — что именно, ничего не заведено.
 */
async function captureCreate(input: {
  channel: EditChannel;
  chatId: number;
  partner: PartnerChatContext;
  parsed: CreateParse;
}): Promise<CabinetScreen> {
  const { partner, parsed } = input;
  if (!partner.userId) return noticeScreen(CREATE_TEXT.noAccount);
  if (parsed.kind === 'hint') return newTourHintScreen();
  if (parsed.kind === 'incomplete') {
    return createIncompleteScreen({ missing: parsed.missing, problems: parsed.problems, specs: parsed.specs });
  }
  const draft = await createTourCreateDraft({
    partnerId: partner.partnerId, channel: input.channel, chatId: input.chatId, source: 'phrase', values: parsed.values,
  });
  if (draft.outcome !== 'created') return failedScreen(CREATE_TEXT.draftFailed);
  return createPreviewScreen({ draftId: draft.id, values: parsed.values });
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
  // Новый тур (31.10) — раньше правки: «новый тур: …» не правка поля.
  const create = createsOwnTours(partner) ? parseTourCreate(input.text) : null;
  if (create) return captureCreate({ channel: input.channel, chatId: input.chatId, partner, parsed: create });
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
  kind: 'my_tours' | 'tour' | 'tour_dates' | 'date_open' | 'date_close' | 'tour_hint' | 'edit_save' | 'edit_cancel' | 'edit_tour'
    | 'tour_new' | 'create_save' | 'create_cancel' | 'tour_publish' | 'tour_unpublish';
}>;

export const GUIDE_TOUR_PRESS_KINDS: ReadonlySet<CabinetPress['kind']> = new Set([
  'my_tours', 'tour', 'tour_dates', 'date_open', 'date_close', 'tour_hint', 'edit_save', 'edit_cancel', 'edit_tour',
  'tour_new', 'create_save', 'create_cancel', 'tour_publish', 'tour_unpublish',
]);

/** Кнопки, которые нужны и гиду без своих туров: список, «Новый тур» и его черновик. */
const CREATE_PRESS_KINDS: ReadonlySet<CabinetPress['kind']> = new Set(['my_tours', 'tour_new', 'create_save', 'create_cancel']);

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
  const allowed = CREATE_PRESS_KINDS.has(press.kind) ? createsOwnTours(partner) : editsOwnTours(partner);
  if (!who.owner || !allowed) return noticeScreen(EDIT_TEXT.notGuide);
  if (!partner.userId) return noticeScreen(EDIT_TEXT.noAccount);
  const site = getPublicBaseUrl();
  const today = kamchatkaDate(new Date(who.nowMs));

  switch (press.kind) {
    case 'my_tours': {
      const own = await readEditTours(partner.partnerId);
      return own.outcome === 'ok' ? myToursScreen(own.tours, site) : failedScreen(EDIT_TEXT.toursFailed);
    }
    case 'tour_new':
      return newTourHintScreen();
    case 'tour':
    case 'tour_hint': {
      const t = await readEditTour(partner.partnerId, press.tourId);
      if (t.outcome === 'db_error') return failedScreen(EDIT_TEXT.toursFailed);
      if (t.outcome === 'not_found') return toursWithNotice(partner.partnerId, EDIT_TEXT.tourNotFound);
      if (press.kind === 'tour_hint') return hintScreen(t.tour);
      return tourWithGate(partner.partnerId, t.tour, site);
    }
    case 'tour_publish':
    case 'tour_unpublish':
      return onSitePress(partner.partnerId, press.tourId, press.kind === 'tour_publish', site);
    case 'create_cancel': {
      const r = await cancelTourCreateDraft({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId });
      return noticeScreen(r.kind === 'cancelled' ? CREATE_TEXT.cancelled : createBlockedText(r));
    }
    case 'create_save': {
      const r = await saveTourCreateDraft({
        partnerId: partner.partnerId, userId: partner.userId, channel: who.channel, chatId: who.chatId, draftId: press.draftId,
      });
      if (r.kind === 'created') {
        const gate = await readPublishGate(partner.partnerId, r.tour.id);
        return createdScreen({ tourId: r.tour.id, title: r.tour.title, blockers: gate.outcome === 'ok' ? gate.blockers : null });
      }
      if (r.kind === 'created_before') {
        const t = await readEditTour(partner.partnerId, r.tourId);
        const head = 'Этот тур уже создан — второй не заводил.';
        if (t.outcome !== 'ok') return noticeScreen(head);
        return tourWithGate(partner.partnerId, t.tour, site, head);
      }
      if (r.kind === 'db_error') return failedScreen(CREATE_TEXT.saveFailed);
      return noticeScreen(createBlockedText(r));
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

function createBlockedText(b: Exclude<SaveCreate, { kind: 'created' | 'created_before' | 'db_error' }> | CancelCreate): string {
  switch (b.kind) {
    case 'not_found': return CREATE_TEXT.notFound;
    case 'cancelled_before': return CREATE_TEXT.cancelledBefore;
    case 'superseded': return CREATE_TEXT.superseded;
    case 'expired': return CREATE_TEXT.expired;
    case 'invalid': return CREATE_TEXT.invalid;
    case 'not_guide': return CREATE_TEXT.notGuide;
    case 'created_before': return 'Этот тур уже создан — второй не заводил.';
    case 'db_error': return CREATE_TEXT.saveFailed;
    case 'cancelled': return CREATE_TEXT.cancelled;
  }
}

/** Экран тура с витринным гейтом: на сайте ли он и чего не хватает. */
async function tourWithGate(partnerId: string, tour: ChatTour, site: string, notice?: string | null): Promise<CabinetScreen> {
  const gate = await readPublishGate(partnerId, tour.id);
  if (gate.outcome === 'not_found') return toursWithNotice(partnerId, EDIT_TEXT.tourNotFound);
  return tourScreen(tour, site, notice, gate.outcome === 'ok' ? { onStorefront: gate.onStorefront, blockers: gate.blockers } : 'unknown');
}

/**
 * «Опубликовать» / «Снять с сайта» — общей функцией сайта и чата
 * (`setOwnTourOnSite`): гейт, владение и ответ шлюза каталога — там.
 */
async function onSitePress(partnerId: string, tourId: string, publish: boolean, site: string): Promise<CabinetScreen> {
  const r = await setOwnTourOnSite({ ownerId: partnerId, tourId, publish });
  if (r.outcome === 'not_found') return toursWithNotice(partnerId, EDIT_TEXT.tourNotFound);
  if (r.outcome === 'db_error') {
    return failedScreen(publish
      ? 'Не опубликовал — база не ответила. Тур остался как был, нажмите ещё раз.'
      : 'Не снял с сайта — база не ответила. Тур остался как был, нажмите ещё раз.');
  }
  let notice: string;
  switch (r.outcome) {
    case 'published': notice = `Опубликовано: «${escapeHtml(r.title)}» на сайте — ${site.replace(/\/$/, '')}${tourPath({ id: tourId, slug: r.slug })}`; break;
    case 'already_on': notice = `«${escapeHtml(r.title)}» уже на сайте — ничего не менял.`; break;
    case 'blocked': notice = `Не опубликовал «${escapeHtml(r.title)}»: тур остался черновиком, не хватает того, что ниже.`; break;
    case 'unpublished': notice = `Снято с сайта: «${escapeHtml(r.title)}» — теперь черновик, туристы его не видят. Брони и даты не тронуты.`; break;
    case 'already_off': notice = `«${escapeHtml(r.title)}» и так не на сайте — ничего не менял.`; break;
  }
  const t = await readEditTour(partnerId, tourId);
  if (t.outcome !== 'ok') return noticeScreen(notice);
  return tourWithGate(partnerId, t.tour, site, notice);
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
