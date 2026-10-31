/**
 * Экраны роли гида в чате кабинета, этап 2 (слово владельца 30.10: «гид должен
 * полностью управлять своей ролью из MAX») — тексты и кнопки, без базы:
 * «Отзывы» и ответ на отзыв, «Профиль и команда», «Расписание», «Заработок».
 *
 * Канал решает, что на экране:
 *  - MAX — подпись автора отзыва как на публичной странице («Анна П.») и
 *    имена с телефонами туристов в группах расписания (`pd: true`);
 *  - Telegram — без них: отзыв без подписи, расписание — числами. Экран с
 *    `pd: true` сервис кабинета в Telegram не отдаёт.
 * Всё, что ввели люди (отзыв, ответ, «о себе», названия), экранируется: HTML
 * разбирает мессенджер.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { cabinetNavRows, type CabinetButton, type CabinetChannel, type CabinetScreen } from '@/lib/chat-cabinet/screens';
import { cabinetPayload, SCHEDULE_MAX_PAGE } from '@/lib/chat-cabinet/payload';
import { ruShort } from '@/lib/analytics/kamchatka-day';
import { formatRub } from '@/lib/transfers/charter-format';
import { OWNER_BOOKING_STATUS_LABEL } from '@/lib/bookings/owner-status-words';
import { GUIDE_REPLY_MAX } from '@/lib/guides/review-reply';
import type { GuideTeam } from '@/lib/guides/team-actions';
import type { GuideSchedule } from '@/lib/guides/schedule-read';
import type { GuideGroup } from '@/lib/guides/groups';
import type { GuideEarnings } from '@/lib/guides/earnings-read';
import { PROFILE_LABEL, type ProfileField, type ProfileReject, type ProfileValue } from './parse';
import { AWAIT_TEXT_MINUTES, DRAFT_TTL_HOURS, REVIEWS_PAGE_SIZE, type ChatProfile, type ChatReview } from './store';

const BUTTON_TEXT_MAX = 40;
/** Дней на странице расписания. */
export const SCHEDULE_DAYS = 14;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function buttonText(s: string): string {
  return clip(s.replace(/\s+/g, ' '), BUTTON_TEXT_MAX);
}

function screen(lines: Array<string | null | undefined>, rows: CabinetButton[][], pd = false): CabinetScreen {
  return {
    text: lines.filter((l): l is string => typeof l === 'string').join('\n'),
    rows: [...rows.filter((r) => r.length > 0), ...cabinetNavRows()],
    pd,
  };
}

function notice(n: string | null | undefined): string | null {
  return n ? `<i>${n}</i>` : null;
}

function stars(n: number): string {
  return `${n} из 5`;
}

function base(url: string): string {
  return url.replace(/\/$/, '');
}

// ── Отзывы ──────────────────────────────────────────────────────────────────

const COMMENT_MAX = 700;
const LIST_COMMENT_MAX = 120;

export function reviewsScreen(args: { reviews: readonly ChatReview[]; total: number; page: number; channel: CabinetChannel }): CabinetScreen {
  const { reviews, total, page } = args;
  const lines: string[] = ['<b>Отзывы</b>'];
  if (total === 0) {
    lines.push('Отзывов пока нет. Их оставляют туристы после поездки.');
    return screen(lines, []);
  }
  const unanswered = reviews.filter((r) => r.reply === null).length;
  lines.push(`Всего: ${total}. На этой странице без ответа: ${unanswered}.`);
  reviews.forEach((r, i) => {
    const n = page * REVIEWS_PAGE_SIZE + i + 1;
    const who = args.channel === 'max' ? ` · ${escapeHtml(r.author)}` : '';
    const text = r.comment ? ` — «${escapeHtml(clip(r.comment.replace(/\s+/g, ' '), LIST_COMMENT_MAX))}»` : '';
    lines.push(`${n}. ${ruShort(r.createdAt)} · ${stars(r.rating)}${who}${r.reply ? ' · есть ответ' : ' · без ответа'}${text}`);
  });
  lines.push('Номер открывает отзыв: ответить, изменить или удалить свой ответ.');
  const rows: CabinetButton[][] = reviews.map((r, i) => [{
    text: buttonText(`${page * REVIEWS_PAGE_SIZE + i + 1}. ${stars(r.rating)}${r.reply ? '' : ' · ответить'}`),
    payload: cabinetPayload.review(r.id),
  }]);
  const nav: CabinetButton[] = [];
  if (page > 0) nav.push({ text: '‹ Назад', payload: cabinetPayload.reviews(page - 1) });
  if ((page + 1) * REVIEWS_PAGE_SIZE < total) nav.push({ text: 'Дальше ›', payload: cabinetPayload.reviews(page + 1) });
  rows.push(nav);
  return screen(lines, rows);
}

export function reviewScreen(args: { review: ChatReview; channel: CabinetChannel; notice?: string | null; fromInbox?: boolean }): CabinetScreen {
  const { review: r, channel } = args;
  const lines: Array<string | null> = [notice(args.notice), `<b>Отзыв · ${stars(r.rating)}</b>`, `Оставлен ${ruShort(r.createdAt)}.`];
  if (channel === 'max') lines.push(`Автор: ${escapeHtml(r.author)} (так подписан на странице гида).`);
  if (!r.isPublic) lines.push('Отзыв скрыт с публичной страницы.');
  if (r.comment && (channel === 'max' || r.isPublic)) lines.push(`«${escapeHtml(clip(r.comment, COMMENT_MAX))}»`);
  else if (r.comment) lines.push('Текст скрытого отзыва — в MAX или в кабинете на сайте.');
  else lines.push('Текста нет — только оценка.');
  lines.push('', r.reply ? `<b>Ваш ответ:</b>\n${escapeHtml(clip(r.reply, COMMENT_MAX))}` : 'Ответа пока нет.');
  lines.push('', 'Ответ виден туристам на вашей странице. Пишется только после кнопки «Опубликовать».');
  const rows: CabinetButton[][] = [[
    { text: r.reply ? 'Изменить ответ' : 'Ответить', payload: cabinetPayload.reviewReply(r.id) },
    ...(r.reply ? [{ text: 'Удалить ответ', payload: cabinetPayload.reviewDelete(r.id), intent: 'negative' as const }] : []),
  ]];
  rows.push(args.fromInbox
    ? [{ text: '‹ Входящие', payload: cabinetPayload.inbox() }, { text: 'Все отзывы', payload: cabinetPayload.reviews() }]
    : [{ text: '‹ Отзывы', payload: cabinetPayload.reviews() }]);
  return screen(lines, rows, channel === 'max');
}

export function awaitReplyScreen(args: { review: ChatReview; draftId: string }): CabinetScreen {
  const { review: r } = args;
  return screen([
    `<b>Ответ на отзыв · ${stars(r.rating)}</b>`,
    r.reply ? 'Пришлите новый текст ответа одним сообщением — он заменит прежний.' : 'Пришлите текст ответа одним сообщением.',
    `До ${GUIDE_REPLY_MAX} знаков. Ответ увидят туристы на вашей странице.`,
    `Я покажу, что опубликую, — опубликуется только после кнопки «Опубликовать». Жду ${AWAIT_TEXT_MINUTES} минут; любая другая кнопка кабинета или слово «отмена» снимает ожидание.`,
  ], [[{ text: 'Отмена', payload: cabinetPayload.draftCancel(args.draftId), intent: 'negative' }]]);
}

export function replyPreviewScreen(args: {
  review: ChatReview;
  draftId: string;
  /** null — удаление ответа. */
  next: string | null;
  live: string | null;
  changedNotice?: boolean;
}): CabinetScreen {
  const lines: string[] = [];
  if (args.changedNotice) lines.push('Пока черновик ждал, ответ на этот отзыв изменили (на сайте или другой кнопкой). Ничего не записал — вот что в нём сейчас.');
  lines.push(`<b>Ответ на отзыв · ${stars(args.review.rating)}</b>`);
  lines.push('<b>Было:</b>', args.live ? escapeHtml(args.live) : '<i>ответа нет</i>', '');
  lines.push('<b>Станет:</b>', args.next ? escapeHtml(args.next) : '<i>ответа нет</i>', '');
  const del = args.next === null;
  lines.push(del
    ? `Ответ исчезнет со страницы после кнопки «Удалить». Черновик ждёт ${DRAFT_TTL_HOURS} часа.`
    : `Ничего не опубликовано, пока вы не нажмёте «Опубликовать». После него ответ сразу виден туристам. Черновик ждёт ${DRAFT_TTL_HOURS} часа.`);
  return screen(lines, [[
    { text: del ? 'Удалить' : 'Опубликовать', payload: cabinetPayload.draftSave(args.draftId), intent: del ? 'negative' : 'positive' },
    { text: 'Отмена', payload: cabinetPayload.draftCancel(args.draftId), intent: 'negative' },
  ]]);
}

// ── Профиль и команда ───────────────────────────────────────────────────────

const PROFILE_STATUS_WORDS: Readonly<Record<string, string>> = {
  none: 'не подан на проверку',
  pending: 'на проверке',
  approved: 'проверен',
  rejected: 'отклонён — причина в кабинете',
};

export function profileValueWords(field: ProfileField, v: ProfileValue | null, max = 300): string {
  if (v === null) return '<i>не записано</i>';
  if (field === 'experience_years') return `${v} ${yearsWord(Number(v))}`;
  if (Array.isArray(v)) return escapeHtml(v.join(', '));
  return escapeHtml(clip(String(v), max));
}

function yearsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'год';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'года';
  return 'лет';
}

export const PROFILE_FORMAT_LINES: readonly string[] = [
  'Править фразой, одним сообщением:',
  '• <code>о себе: …</code> — текст на вашей странице',
  '• <code>опыт: 12</code> — лет работы гидом',
  '• <code>языки: русский, английский</code>',
  'Я покажу «было → станет», запишется только после кнопки «Сохранить».',
];

export function profileScreen(args: {
  profile: ChatProfile;
  /** null — команда не прочиталась. */
  team: GuideTeam | null;
  siteBase: string;
  guidePageUrl: string;
  notice?: string | null;
}): CabinetScreen {
  const { profile: p, team } = args;
  const lines: Array<string | null> = [notice(args.notice), '<b>Профиль</b>', `Вывеска: ${escapeHtml(p.name)}`];
  lines.push(`Проверка профиля: ${PROFILE_STATUS_WORDS[p.profileStatus ?? 'none'] ?? escapeHtml(p.profileStatus ?? '')}.`);
  for (const f of ['description', 'experience_years', 'languages'] as const) {
    lines.push(`${PROFILE_LABEL[f]}: ${profileValueWords(f, p.fields[f])}`);
  }
  lines.push('', ...PROFILE_FORMAT_LINES);
  lines.push('Имя на сайте, телефон, специализации, место и фото — в кабинете на сайте.');
  lines.push('', '<b>Команда</b>');
  const rows: CabinetButton[][] = [];
  if (team === null) {
    lines.push('Команда и приглашения не прочитались — это не «приглашений нет». Откройте раздел ещё раз.');
  } else {
    lines.push(team.operator
      ? `Вы в команде оператора «${escapeHtml(team.operator.name ?? 'без названия')}»: он назначает вас на свои брони.`
      : 'Вы не в команде оператора.');
    if (team.invites.length === 0) lines.push('Приглашений, ждущих ответа, нет.');
    for (const inv of team.invites.slice(0, 4)) {
      lines.push(`Приглашение от «${escapeHtml(inv.operatorName ?? 'оператор')}».`);
      rows.push([
        { text: buttonText(`Принять: ${inv.operatorName ?? 'оператор'}`), payload: cabinetPayload.inviteAccept(inv.id), intent: 'positive' },
        { text: 'Отклонить', payload: cabinetPayload.inviteDecline(inv.id), intent: 'negative' },
      ]);
    }
    if (team.invites.length > 4) lines.push('Остальные приглашения — в кабинете на сайте.');
    if (team.operator && team.invites.length > 0) lines.push('Принять другое приглашение можно, только выйдя из текущей команды.');
    if (team.operator) rows.push([{ text: 'Выйти из команды', payload: cabinetPayload.teamLeave(), intent: 'negative' }]);
  }
  rows.push([{ text: 'Моя страница', url: args.guidePageUrl }, { text: 'Кабинет на сайте', url: `${base(args.siteBase)}/hub/guide/profile` }]);
  return screen(lines, rows);
}

export function profilePreviewScreen(args: {
  draftId: string;
  field: ProfileField;
  next: ProfileValue;
  live: ProfileValue | null;
  changedNotice?: boolean;
}): CabinetScreen {
  const lines: string[] = [];
  if (args.changedNotice) lines.push('Пока черновик ждал, это поле профиля изменили (на сайте или другой кнопкой). Ничего не записал — вот что в нём сейчас.');
  lines.push(`<b>Профиль — ${PROFILE_LABEL[args.field]}</b>`);
  lines.push('<b>Было:</b>', profileValueWords(args.field, args.live, 1500), '', '<b>Станет:</b>', profileValueWords(args.field, args.next, 3000));
  if (args.field === 'description' && String(args.next).length > 3000) lines.push('(Здесь сокращено для чата — сохранится полностью.)');
  lines.push('', `Ничего не записано, пока вы не нажмёте «Сохранить». После него — сразу на вашей странице. Черновик ждёт ${DRAFT_TTL_HOURS} часа.`);
  return screen(lines, [[
    { text: 'Сохранить', payload: cabinetPayload.draftSave(args.draftId), intent: 'positive' },
    { text: 'Отмена', payload: cabinetPayload.draftCancel(args.draftId), intent: 'negative' },
  ]]);
}

export function leaveAskScreen(operatorName: string | null): CabinetScreen {
  return screen([
    `Выйти из команды оператора «${escapeHtml(operatorName ?? 'без названия')}»?`,
    'Он больше не сможет назначать вас на брони; на будущие брони, куда вы уже назначены, вас снимут. Вернуться — только по новому приглашению.',
  ], [[
    { text: 'Да, выйти', payload: cabinetPayload.teamLeaveYes(), intent: 'negative' },
    { text: 'Не выходить', payload: cabinetPayload.profile() },
  ]]);
}

export function inviteCardScreen(args: { inviteId: string; operatorName: string | null; waiting: boolean }): CabinetScreen {
  const name = escapeHtml(args.operatorName ?? 'оператор');
  if (!args.waiting) {
    return screen([`<b>Приглашение в команду</b>`, `«${name}» — на приглашение уже ответили.`], [[{ text: '‹ Входящие', payload: cabinetPayload.inbox() }]]);
  }
  return screen([
    '<b>Приглашение в команду</b>',
    `Оператор «${name}» приглашает вас в свою команду: он сможет назначать вас гидом на свои брони, а вы увидите группу и контакт туриста.`,
    'Гид ведёт одного оператора за раз. Ответ записывается сразу.',
  ], [
    [
      { text: 'Принять', payload: cabinetPayload.inviteAccept(args.inviteId), intent: 'positive' },
      { text: 'Отклонить', payload: cabinetPayload.inviteDecline(args.inviteId), intent: 'negative' },
    ],
    [{ text: '‹ Входящие', payload: cabinetPayload.inbox() }, { text: 'Профиль и команда', payload: cabinetPayload.profile() }],
  ]);
}

// ── Расписание ──────────────────────────────────────────────────────────────

const SCHEDULE_STATUS_WORDS: Readonly<Record<string, string>> = {
  scheduled: 'запланировано',
  in_progress: 'идёт',
  completed: 'проведено',
  cancelled: 'отменено',
};

const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

function bookingWords(status: string): string {
  return escapeHtml(OWNER_BOOKING_STATUS_LABEL[status] ?? status);
}

export function scheduleScreen(args: {
  from: string;
  to: string;
  page: number;
  channel: CabinetChannel;
  schedule: GuideSchedule;
  /** Группы с контактами туристов — только для MAX; null в Telegram. */
  groups: { inTeam: boolean; groups: GuideGroup[] } | null;
  siteBase: string;
}): CabinetScreen {
  const { from, to, schedule } = args;
  const lines: string[] = [`<b>Расписание</b> · ${ruShort(from)}–${ruShort(to)}`];
  const days = new Map<string, string[]>();
  const add = (date: string, line: string) => {
    const d = date.slice(0, 10);
    if (d < from || d > to) return;
    days.set(d, [...(days.get(d) ?? []), line]);
  };
  for (const e of schedule.schedule) {
    const time = e.endTime ? `${e.startTime}–${e.endTime}` : e.startTime;
    const what = escapeHtml(e.title ?? e.tourTitle ?? 'запись календаря');
    const where = e.locationName ? `, ${escapeHtml(e.locationName)}` : '';
    const st = SCHEDULE_STATUS_WORDS[e.status ?? ''] ?? (e.status ? escapeHtml(e.status) : '');
    add(e.date, `  ${time} ${what}${where}${st ? ` (${st})` : ''}`);
  }
  let pd = false;
  if (args.groups) {
    for (const g of args.groups.groups) {
      const head = `  Группа: ${escapeHtml(g.tourTitle)} — ${g.totalParticipants} чел.${g.operatorName ? `, оператор «${escapeHtml(g.operatorName)}»` : ''}`;
      const meet = g.meetingPoint ? `\n    сбор: ${escapeHtml(g.meetingPoint)}` : '';
      const people = g.bookings.map((b) => {
        const who = [b.touristName, b.touristPhone].filter((x): x is string => typeof x === 'string' && x.length > 0).map(escapeHtml).join(', ');
        if (who) pd = true;
        return `\n    · ${who || 'турист'} — ${b.participants} чел., ${bookingWords(b.status)}`;
      }).join('');
      add(g.date, `${head}${meet}${people}`);
    }
  } else {
    const byTour = new Map<string, { date: string; title: string; people: number; n: number }>();
    for (const a of schedule.assignments) {
      const key = `${a.date}:${a.tourTitle}`;
      const cur = byTour.get(key) ?? { date: a.date, title: a.tourTitle, people: 0, n: 0 };
      cur.people += a.participants;
      cur.n += 1;
      byTour.set(key, cur);
    }
    for (const g of byTour.values()) add(g.date, `  Группа: ${escapeHtml(g.title)} — ${g.people} чел., броней ${g.n}`);
  }
  if (days.size === 0) {
    lines.push('На эти дни записей календаря и назначений на брони нет.');
  } else {
    for (const d of [...days.keys()].sort()) lines.push(`<b>${ruShort(d)} ${weekday(d)}</b>`, ...(days.get(d) ?? []));
  }
  if (args.groups && !args.groups.inTeam) lines.push('Вы не в команде оператора — назначений на брони нет.');
  if (args.channel !== 'max') lines.push('Имена и телефоны туристов в группах — в MAX и в кабинете на сайте.');
  lines.push('Добавить или изменить запись календаря — в кабинете на сайте.');
  const nav: CabinetButton[] = [];
  if (args.page > 0) nav.push({ text: '‹ Раньше', payload: cabinetPayload.schedule(args.page - 1) });
  if (args.page < SCHEDULE_MAX_PAGE) nav.push({ text: 'Позже ›', payload: cabinetPayload.schedule(args.page + 1) });
  return screen(lines, [nav, [{ text: 'Календарь на сайте', url: `${base(args.siteBase)}/hub/guide/schedule` }]], pd);
}

// ── Заработок ───────────────────────────────────────────────────────────────

const EARNING_STATUS_WORDS: Readonly<Record<string, string>> = {
  paid: 'выплачено', pending: 'ждёт выплаты', cancelled: 'отменено', unknown: 'статус не записан',
};

export function earningsScreen(e: GuideEarnings, siteBase: string): CabinetScreen {
  const s = e.summary;
  const lines: string[] = ['<b>Заработок за 30 дней</b>'];
  if (s.count === 0) {
    lines.push('Начислений за 30 дней в кабинете не записано — это не «заработано 0 ₽».');
    lines.push('Оплата через платформу не принимается: за свои туры туристы платят вам напрямую.');
  } else {
    const rub = (v: number | null) => (v === null ? 'нет данных' : formatRub(v));
    lines.push(`Начислено: ${rub(s.totalEarnings)} — ${s.count} начисл.`);
    lines.push(`Выплачено: ${rub(s.paid)}. Ждёт выплаты: ${rub(s.pendingPayment)}.`);
    lines.push(s.toursWithEarnings === null ? 'Туров с начислениями: нет данных.' : `Туров с начислениями: ${s.toursWithEarnings} (по записям календаря).`);
    for (const it of e.items.slice(0, 5)) {
      const tour = it.tourName ? ` · ${escapeHtml(it.tourName)}` : '';
      lines.push(`• ${ruShort(it.date)} · ${formatRub(it.amount)} · ${EARNING_STATUS_WORDS[it.status] ?? it.status}${tour}`);
    }
    if (e.items.length > 5) lines.push(`…и ещё ${e.items.length - 5} — в кабинете на сайте.`);
  }
  return screen(lines, [[{ text: 'Заработок на сайте', url: `${base(siteBase)}/hub/guide/earnings` }]]);
}

// ── Тексты ──────────────────────────────────────────────────────────────────

export const ROLE_TEXT = {
  notGuide: 'Это раздел кабинета гида. Ничего не открыл и не записал.',
  noAccount: 'Записывать из чата может карточка с кабинетом на сайте. Ничего не записал.',
  reviewsFailed: 'Отзывы не прочитались — база не ответила. Это не «отзывов нет».',
  reviewNotFound: 'Этот отзыв не найден среди отзывов о вас — ничего не открыл и не записал.',
  profileFailed: 'Профиль не прочитался — база не ответила. Ничего не записал.',
  scheduleFailed: 'Расписание не прочиталось — база не ответила. Это не «записей нет».',
  earningsFailed: 'Заработок не прочитался — база не ответила. Это не «ноль».',
  draftFailed: 'Черновик не записался — база не ответила. Ничего не изменено, попробуйте ещё раз.',
  saveFailed: 'Не записалось — база не ответила. Ничего не изменено, нажмите кнопку ещё раз.',
  notFound: 'Этот черновик не найден в этом чате — ничего не изменено.',
  savedBefore: 'Это уже записано.',
  cancelledBefore: 'Это уже отменили — ничего не изменено.',
  superseded: 'Этот черновик заменило ваше следующее действие — записывается только последнее. Ничего не изменено.',
  expired: 'Черновик устарел. Ничего не изменено — начните заново.',
  awaitingText: 'Сначала пришлите текст ответа сообщением.',
  cancelled: 'Отменено. Ничего не изменено.',
  noReply: 'Ответа на этот отзыв нет — удалять нечего.',
  targetGone: 'Отзыв удалён или больше не ваш — ничего не записал.',
  sameReply: 'Это ровно текущий ответ — публиковать нечего.',
  sameProfile: 'Это ровно то, что уже записано в профиле, — сохранять нечего.',
  awaitUnchecked: 'Не удалось проверить, ждёт ли чат ответ на отзыв. Сообщение никуда не отправил и не опубликовал — повторите через минуту.',
  awaitYielded: 'Ответ на отзыв снят: после «Ответить» вы нажали кнопку брони или заявки. Сообщение не опубликовал. Если это был ответ — нажмите «Ответить» ещё раз.',
  awaitCancelled: 'Ответ не опубликован — ожидание снято.',
  teamFailed: 'Не получилось — база не ответила. Ничего не изменено, попробуйте ещё раз.',
  inviteGone: 'Приглашение не найдено или уже закрыто — ничего не изменено.',
  otherTeam: 'Вы уже в команде другого оператора. Чтобы принять это приглашение, сначала выйдите из текущей команды. Ничего не изменено.',
  notInTeam: 'Вы не состоите в команде оператора — выходить неоткуда.',
} as const;

export function replyTooLong(got: number): string {
  return `В ответе ${got} знаков, а помещается ${GUIDE_REPLY_MAX}. Пришлите короче — я жду. Ничего не опубликовал.`;
}

export function profileRejectText(field: ProfileField, r: ProfileReject): string {
  const name = PROFILE_LABEL[field];
  switch (r.reason) {
    case 'empty': return `${name}: после двоеточия пусто. Ничего не записал.`;
    case 'too_long': return `${name}: ${r.got} знаков, а помещается ${r.max}. Сократите — ничего не записал.`;
    case 'bad_years': return 'Опыт — числом лет от 0 до 60: «опыт: 12». Ничего не записал.';
    case 'too_many': return `${name}: ${r.got} пунктов, а помещается ${r.max}. Ничего не записал.`;
    case 'item_too_long': return `${name}: пункт ${r.index} длиннее ${r.max} знаков. Ничего не записал.`;
  }
}

export function guidePageUrl(siteBase: string, partnerId: string): string {
  return `${base(siteBase)}/guides/${partnerId}`;
}

