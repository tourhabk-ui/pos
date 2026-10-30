/**
 * Роль гида в чате кабинета, этап 2 (слово владельца 30.10: «гид должен
 * полностью управлять своей ролью из MAX»). Этап 1 — свои туры
 * (lib/guides/tour-edit); здесь — то, что раньше было только на сайте:
 *  - ответ на отзыв: «Ответить» → текст следующим сообщением → «было →
 *    станет» → «Опубликовать»; изменить и удалить свой ответ — так же;
 *  - приглашение в команду оператора: «Принять» / «Отклонить»; «Выйти из
 *    команды» — с подтверждением;
 *  - «Расписание» на 14 дней — записи календаря и группы;
 *  - «Заработок» за 30 дней;
 *  - профиль: «о себе: …», «опыт: 12», «языки: …» → «было → станет» →
 *    «Сохранить».
 *
 * Каждая запись — той же функцией, что кабинет на сайте
 * (lib/guides/review-reply, team-actions, profile-write), и только кнопкой
 * после предпросмотра. Модель эти фразы не видит и в базу не пишет: иначе она
 * сказала бы «опубликовал», ничего не опубликовав.
 *
 * Кто вправе: карточка гида этого чата, владелец чата (не менеджер команды),
 * запись — с кабинетом (`partners.user_id`); личный диалог и заверенность
 * апдейта проверяет вызывающий. Чей отзыв и чьё приглашение — условие в SQL.
 */

import type { PartnerChatContext } from '@/lib/kuzmich/operator-chat';
import { menuRoleOf, roleMenuAsk } from '@/lib/roles/role-menu';
import { getPublicBaseUrl } from '@/lib/config';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';
import { detectEmergency } from '@/lib/safety/sos-detector';
import { isWatchTrigger } from '@/lib/kuzmich/watch-flow';
import { escapeHtml } from '@/lib/text/escape-html';
import { failedScreen, noticeScreen, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import type { CabinetPress } from '@/lib/chat-cabinet/payload';
import type { InboxItem } from '@/lib/crm/inbox';
import { GuideReplySchema } from '@/lib/guides/review-reply';
import { leaveGuideTeam, readGuideTeam, respondGuideInvite, type GuideTeam } from '@/lib/guides/team-actions';
import { readGuideGroups, readGuideSchedule } from '@/lib/guides/schedule-read';
import { readGuideEarnings } from '@/lib/guides/earnings-read';
import { logGuideFailure } from '@/lib/guides/db-failure';
import { parseTourEdit } from '@/lib/guides/tour-edit/parse';
import { parseProfileEdit, type ProfileField, type ProfileValue } from './parse';
import {
  cancelRoleDraft, createRoleDraft, dropAwaiting, fillAwaiting, findAwaitingReply, listOwnReviews, readOwnProfile,
  readOwnReview, sameValue, saveRoleDraft, type DraftBlocked, type RoleChannel,
} from './store';
import {
  ROLE_TEXT, SCHEDULE_DAYS, awaitReplyScreen, earningsScreen, guidePageUrl, inviteCardScreen, leaveAskScreen,
  profilePreviewScreen, profileRejectText, profileScreen, replyPreviewScreen, replyTooLong, reviewScreen, reviewsScreen,
  scheduleScreen,
} from './screens';

type RolePartner = Pick<PartnerChatContext, 'partnerId' | 'userId' | 'category' | 'slug' | 'sellsTours'>;

/** Карточка гида (с турами или из команды): у неё раздел роли гида в чате. */
export function isGuideCard(p: Pick<PartnerChatContext, 'partnerId' | 'category' | 'slug' | 'sellsTours'>): boolean {
  return menuRoleOf(p) === 'guide';
}

const CANCEL_WORDS = /^(?:отмена|отмени(?:те)?|стоп|не надо|не нужно|отбой)$/u;

function normWords(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

function blockedText(b: DraftBlocked): string {
  switch (b.kind) {
    case 'not_found': return ROLE_TEXT.notFound;
    case 'saved_before': return ROLE_TEXT.savedBefore;
    case 'cancelled_before': return ROLE_TEXT.cancelledBefore;
    case 'superseded': return ROLE_TEXT.superseded;
    case 'expired': return ROLE_TEXT.expired;
    case 'awaiting_text': return ROLE_TEXT.awaitingText;
    case 'db_error': return ROLE_TEXT.saveFailed;
  }
}

// ── Текст гида ──────────────────────────────────────────────────────────────

/**
 * Сообщение гида в личном диалоге: текст ответа на отзыв (после «Ответить»)
 * или правка профиля фразой. `null` — не это: сообщение идёт дальше своим
 * путём (правка тура, помощник). Беда и контроль выхода — всегда своим путём.
 */
export async function captureGuideRoleText(input: {
  channel: RoleChannel;
  chatId: number;
  partner: RolePartner;
  text: string;
}): Promise<CabinetScreen | null> {
  const { partner } = input;
  if (!isGuideCard(partner)) return null;
  const text = input.text.trim();
  if (!text) return null;
  const urgent = () => detectEmergency(text).detected || isWatchTrigger(text);

  const waiting = await findAwaitingReply(input.channel, input.chatId);
  if (waiting === 'db_error') {
    // «Не смог проверить» — не «не ждёт» (§4.0): сообщение могло быть
    // ответом туристу. Беда и контроль выхода — своим путём при любом отказе.
    return urgent() ? null : failedScreen(ROLE_TEXT.awaitUnchecked);
  }
  if (waiting) {
    const profileOrTour = parseProfileEdit(text) !== null || parseTourEdit(text) !== null;
    const passOn = waiting.partnerId !== partner.partnerId || urgent() || text.startsWith('/')
      || roleMenuAsk(text) !== null || profileOrTour;
    if (passOn || waiting.newer) {
      await dropAwaiting(waiting.id, 'superseded');
      if (waiting.newer && !passOn) return noticeScreen(ROLE_TEXT.awaitYielded);
    } else if (CANCEL_WORDS.test(normWords(text))) {
      await dropAwaiting(waiting.id, 'cancelled');
      return noticeScreen(ROLE_TEXT.awaitCancelled);
    } else {
      return replyText(input, partner, waiting, text);
    }
  }
  return profileText(input, partner, text);
}

async function replyText(
  input: { channel: RoleChannel; chatId: number },
  partner: RolePartner,
  waiting: { id: string; reviewId: string; liveValue: unknown },
  text: string,
): Promise<CabinetScreen | null> {
  const parsed = GuideReplySchema.safeParse({ reply: text });
  if (!parsed.success) return noticeScreen(text.length > 0 ? replyTooLong(text.length) : ROLE_TEXT.awaitingText);
  const live = typeof waiting.liveValue === 'string' ? waiting.liveValue : null;
  if (sameValue(live, parsed.data.reply)) {
    await dropAwaiting(waiting.id, 'cancelled');
    return noticeScreen(ROLE_TEXT.sameReply);
  }
  const filled = await fillAwaiting(waiting.id, parsed.data.reply);
  if (filled === 'db_error') return failedScreen(ROLE_TEXT.draftFailed);
  // Второе сообщение того же мгновения уже забрало ожидание.
  if (!filled) return null;
  const r = await readOwnReview(partner.partnerId, waiting.reviewId);
  if (r.outcome === 'db_error') return failedScreen(ROLE_TEXT.reviewsFailed);
  if (r.outcome === 'not_found') return noticeScreen(ROLE_TEXT.targetGone);
  return replyPreviewScreen({ review: r.review, draftId: waiting.id, next: parsed.data.reply, live });
}

async function profileText(
  input: { channel: RoleChannel; chatId: number },
  partner: RolePartner,
  text: string,
): Promise<CabinetScreen | null> {
  const parsed = parseProfileEdit(text);
  if (parsed === null) return null;
  if (!partner.userId) return noticeScreen(ROLE_TEXT.noAccount);
  if (!parsed.ok) return noticeScreen(profileRejectText(parsed.field, parsed));
  const p = await readOwnProfile(partner.partnerId);
  if (p.outcome === 'db_error') return failedScreen(ROLE_TEXT.profileFailed);
  if (p.outcome === 'not_found') return noticeScreen(ROLE_TEXT.notGuide);
  const live = p.profile.fields[parsed.field];
  if (sameValue(live, parsed.value)) return noticeScreen(ROLE_TEXT.sameProfile);
  const draft = await createRoleDraft({
    partnerId: partner.partnerId, channel: input.channel, chatId: input.chatId, kind: 'profile', reviewId: null,
    field: parsed.field, newValue: parsed.value, liveValue: live, awaiting: false,
  });
  if (draft.outcome !== 'created') return failedScreen(ROLE_TEXT.draftFailed);
  return profilePreviewScreen({ draftId: draft.id, field: parsed.field, next: parsed.value, live });
}

// ── Кнопки ──────────────────────────────────────────────────────────────────

type RolePress = Extract<CabinetPress, {
  kind: 'reviews' | 'review' | 'review_reply' | 'review_delete' | 'draft_save' | 'draft_cancel' | 'schedule'
    | 'earnings' | 'profile' | 'invite_accept' | 'invite_decline' | 'team_leave' | 'team_leave_yes';
}>;

/** Кнопки, которые пишут: им нужен кабинет на сайте у карточки. */
const WRITES: ReadonlySet<CabinetPress['kind']> = new Set([
  'review_reply', 'review_delete', 'draft_save', 'invite_accept', 'invite_decline', 'team_leave_yes',
]);

export interface RoleWho {
  partner: RolePartner;
  /** Владелец карточки, не менеджер команды. */
  owner: boolean;
  channel: RoleChannel;
  chatId: number;
  nowMs: number;
}

/**
 * Кнопка роли гида. Чат и карточку проверил сервис кабинета; здесь — что
 * карточка гида, нажимает владелец, и (для записи) что у неё есть кабинет.
 */
export async function guideRolePress(press: RolePress, who: RoleWho): Promise<CabinetScreen> {
  const { partner } = who;
  if (!who.owner || !isGuideCard(partner)) return noticeScreen(ROLE_TEXT.notGuide);
  if (WRITES.has(press.kind) && !partner.userId) return noticeScreen(ROLE_TEXT.noAccount);
  const site = getPublicBaseUrl();
  switch (press.kind) {
    case 'reviews': {
      const r = await listOwnReviews(partner.partnerId, press.page);
      return r.outcome === 'ok'
        ? reviewsScreen({ reviews: r.reviews, total: r.total, page: press.page, channel: who.channel })
        : failedScreen(ROLE_TEXT.reviewsFailed);
    }
    case 'review': return reviewView(partner.partnerId, press.reviewId, who.channel);
    case 'review_reply': {
      const r = await readOwnReview(partner.partnerId, press.reviewId);
      if (r.outcome === 'db_error') return failedScreen(ROLE_TEXT.reviewsFailed);
      if (r.outcome === 'not_found') return noticeScreen(ROLE_TEXT.reviewNotFound);
      const d = await createRoleDraft({
        partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, kind: 'reply', reviewId: r.review.id,
        field: null, newValue: null, liveValue: r.review.reply, awaiting: true,
      });
      return d.outcome === 'created' ? awaitReplyScreen({ review: r.review, draftId: d.id }) : failedScreen(ROLE_TEXT.draftFailed);
    }
    case 'review_delete': {
      const r = await readOwnReview(partner.partnerId, press.reviewId);
      if (r.outcome === 'db_error') return failedScreen(ROLE_TEXT.reviewsFailed);
      if (r.outcome === 'not_found') return noticeScreen(ROLE_TEXT.reviewNotFound);
      if (r.review.reply === null) return reviewScreen({ review: r.review, channel: who.channel, notice: ROLE_TEXT.noReply });
      const d = await createRoleDraft({
        partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, kind: 'reply_delete', reviewId: r.review.id,
        field: null, newValue: null, liveValue: r.review.reply, awaiting: false,
      });
      return d.outcome === 'created'
        ? replyPreviewScreen({ review: r.review, draftId: d.id, next: null, live: r.review.reply })
        : failedScreen(ROLE_TEXT.draftFailed);
    }
    case 'draft_cancel': {
      const r = await cancelRoleDraft({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId: press.draftId });
      return noticeScreen(r.kind === 'cancelled' ? ROLE_TEXT.cancelled : blockedText(r));
    }
    case 'draft_save': return draftSave(press.draftId, who, site);
    case 'schedule': return scheduleView(partner.partnerId, press.page, who, site);
    case 'earnings': {
      try {
        return earningsScreen(await readGuideEarnings(partner.partnerId, '30d'), site);
      } catch (err) {
        logGuideFailure('заработок гида в чате', err);
        return failedScreen(ROLE_TEXT.earningsFailed);
      }
    }
    case 'profile': return profileView(partner.partnerId, site);
    case 'invite_accept':
    case 'invite_decline': {
      let notice: string;
      try {
        const r = await respondGuideInvite(partner.partnerId, press.inviteId, press.kind === 'invite_accept' ? 'accept' : 'decline');
        notice = r.kind === 'not_found' ? ROLE_TEXT.inviteGone
          : r.kind === 'other_team' ? ROLE_TEXT.otherTeam
            : press.kind === 'invite_accept' ? 'Вы в команде оператора: он может назначать вас на свои брони.' : 'Приглашение отклонено.';
      } catch (err) {
        logGuideFailure('ответ на приглашение из чата', err);
        return failedScreen(ROLE_TEXT.teamFailed);
      }
      return profileView(partner.partnerId, site, notice);
    }
    case 'team_leave': {
      let team: GuideTeam;
      try {
        team = await readGuideTeam(partner.partnerId);
      } catch (err) {
        logGuideFailure('команда гида в чате', err);
        return failedScreen(ROLE_TEXT.teamFailed);
      }
      if (!team.operator) return profileView(partner.partnerId, site, ROLE_TEXT.notInTeam);
      return leaveAskScreen(team.operator.name);
    }
    case 'team_leave_yes': {
      let left: boolean;
      try {
        left = await leaveGuideTeam(partner.partnerId);
      } catch (err) {
        logGuideFailure('выход из команды из чата', err);
        return failedScreen(ROLE_TEXT.teamFailed);
      }
      return profileView(partner.partnerId, site, left
        ? 'Вы вышли из команды оператора. Будущие назначения сняты.'
        : ROLE_TEXT.notInTeam);
    }
  }
}

async function reviewView(partnerId: string, reviewId: string, channel: RoleChannel, opts: { notice?: string; fromInbox?: boolean } = {}): Promise<CabinetScreen> {
  const r = await readOwnReview(partnerId, reviewId);
  if (r.outcome === 'db_error') return failedScreen(ROLE_TEXT.reviewsFailed);
  if (r.outcome === 'not_found') return noticeScreen(ROLE_TEXT.reviewNotFound);
  return reviewScreen({ review: r.review, channel, notice: opts.notice, fromInbox: opts.fromInbox });
}

async function profileView(partnerId: string, site: string, notice?: string): Promise<CabinetScreen> {
  const p = await readOwnProfile(partnerId);
  if (p.outcome === 'db_error') return failedScreen(notice ? `${escapeHtml(notice)}\n${ROLE_TEXT.profileFailed}` : ROLE_TEXT.profileFailed);
  if (p.outcome === 'not_found') return noticeScreen(ROLE_TEXT.notGuide);
  let team: GuideTeam | null = null;
  try {
    team = await readGuideTeam(partnerId);
  } catch (err) {
    logGuideFailure('команда гида в чате', err);
  }
  return profileScreen({ profile: p.profile, team, siteBase: site, guidePageUrl: guidePageUrl(site, partnerId), notice });
}

async function scheduleView(partnerId: string, page: number, who: RoleWho, site: string): Promise<CabinetScreen> {
  const today = kamchatkaDate(new Date(who.nowMs));
  const from = shiftDate(today, page * SCHEDULE_DAYS);
  const to = shiftDate(from, SCHEDULE_DAYS - 1);
  try {
    // Telegram ПД не получает — группы с контактами туристов там и не читаются.
    const [schedule, groups] = await Promise.all([
      readGuideSchedule(partnerId, from, to),
      who.channel === 'max' ? readGuideGroups(partnerId) : Promise.resolve(null),
    ]);
    return scheduleScreen({ from, to, page, channel: who.channel, schedule, groups, siteBase: site });
  } catch (err) {
    logGuideFailure('расписание гида в чате', err);
    return failedScreen(ROLE_TEXT.scheduleFailed);
  }
}

async function draftSave(draftId: string, who: RoleWho, site: string): Promise<CabinetScreen> {
  const { partner } = who;
  const r = await saveRoleDraft({ partnerId: partner.partnerId, channel: who.channel, chatId: who.chatId, draftId });
  switch (r.kind) {
    case 'saved': {
      if (r.draft.kind === 'profile') {
        return profileView(partner.partnerId, site, 'Сохранено — на вашей странице сразу.');
      }
      const done = r.draft.kind === 'reply_delete' ? 'Ответ удалён со страницы.' : 'Опубликовано: ответ виден туристам на вашей странице.';
      return reviewView(partner.partnerId, r.draft.reviewId ?? '', who.channel, { notice: done });
    }
    case 'changed': {
      if (r.draft.kind === 'profile') {
        const field = r.draft.field as ProfileField;
        return profilePreviewScreen({
          draftId, field, next: r.draft.newValue as ProfileValue, live: r.draft.liveValue as ProfileValue | null, changedNotice: true,
        });
      }
      const rev = await readOwnReview(partner.partnerId, r.draft.reviewId ?? '');
      if (rev.outcome !== 'ok') return rev.outcome === 'db_error' ? failedScreen(ROLE_TEXT.reviewsFailed) : noticeScreen(ROLE_TEXT.targetGone);
      return replyPreviewScreen({
        review: rev.review, draftId,
        next: r.draft.kind === 'reply_delete' ? null : String(r.draft.newValue ?? ''),
        live: typeof r.draft.liveValue === 'string' ? r.draft.liveValue : null,
        changedNotice: true,
      });
    }
    case 'target_gone': return noticeScreen(ROLE_TEXT.targetGone);
    case 'nothing_to_delete': return noticeScreen(ROLE_TEXT.noReply);
    case 'invalid': return noticeScreen(`${escapeHtml(r.error)}. Ничего не записал.`);
    case 'db_error': return failedScreen(ROLE_TEXT.saveFailed);
    default: return noticeScreen(blockedText(r));
  }
}

// ── Карточка «Входящих» ─────────────────────────────────────────────────────

/**
 * Карточка отзыва и приглашения во «Входящих» гида — с кнопками ответа
 * вместо ссылки на сайт. null — не этот случай: обычная карточка.
 */
export async function guideInboxCard(item: InboxItem, who: Pick<RoleWho, 'partner' | 'owner' | 'channel'>): Promise<CabinetScreen | null> {
  if (!who.owner || !isGuideCard(who.partner)) return null;
  if (item.kind === 'guide_review') return reviewView(who.partner.partnerId, item.id, who.channel, { fromInbox: true });
  if (item.kind === 'guide_invite') {
    // Кнопки судит SQL ответа: закрытое приглашение — «не найдено», ничего не изменено.
    return inviteCardScreen({ inviteId: item.id, operatorName: item.title, waiting: true });
  }
  return null;
}
