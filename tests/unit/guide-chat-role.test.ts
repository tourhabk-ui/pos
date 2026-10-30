/**
 * Роль гида в чате кабинета, этап 2 (слово владельца 30.10: «гид должен
 * полностью управлять своей ролью из MAX»): ответ на отзыв, профиль, команда
 * оператора, расписание, заработок, срок аттестата в сводке.
 *
 * Судится поведением, вызовом функций и роутов:
 *  - фраза профиля — правилами на граничных фразах: что правка, что нет, что
 *    отказ с причиной; слова поля не перехватывают правку тура;
 *  - без кнопки не пишется ничего: текст ответа и фраза профиля заводят
 *    только черновик (ни UPDATE guide_reviews, ни UPDATE partners);
 *  - сайт и чат пишут ОДНОЙ функцией: роут ответа на отзыв и «Опубликовать»
 *    зовут `writeGuideReviewReply`, роут профиля и «Сохранить» —
 *    `writeGuideProfilePatch`, роут команды и «Принять» — `respondGuideInvite`;
 *  - чужой отзыв, чужая карточка, менеджер команды — отказ без записи;
 *  - Telegram не получает подписи автора отзыва и имён туристов;
 *  - «нет данных» и «не загрузилось» — разные слова (§4.0);
 *  - срок аттестата — строка сводки ровно за 30, 7 и 1 день.
 * Путь записи на настоящей базе — tests/integration/chat-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  reply: vi.fn(),
  profile: vi.fn(),
  invite: vi.fn(),
  leave: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({
  transaction: async (fn: (c: { query: typeof h.query }) => unknown) => fn({ query: h.query }),
  query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn(async () => ({ userId: 'user-guide', role: 'guide' })),
}));
vi.mock('@/lib/auth/guide-helpers', () => ({
  verifyReviewOwnership: vi.fn(async () => true),
  getGuidePartnerId: vi.fn(async () => GUIDE),
  getGuidePartnerByUserId: vi.fn(async () => ({ id: GUIDE, name: 'Гид' })),
  ensureGuidePartnerExists: vi.fn(),
  getGuideStats: vi.fn(),
}));
// Общие функции записи — настоящие, но под наблюдением: сайт и чат обязаны звать их.
vi.mock('@/lib/guides/review-reply', async (orig) => {
  const real = await orig<typeof import('@/lib/guides/review-reply')>();
  return {
    ...real,
    writeGuideReviewReply: (...a: Parameters<typeof real.writeGuideReviewReply>) => { h.reply(a[1]); return real.writeGuideReviewReply(...a); },
  };
});
vi.mock('@/lib/guides/profile-write', async (orig) => {
  const real = await orig<typeof import('@/lib/guides/profile-write')>();
  return {
    ...real,
    writeGuideProfilePatch: (...a: Parameters<typeof real.writeGuideProfilePatch>) => { h.profile(a[1]); return real.writeGuideProfilePatch(...a); },
  };
});
vi.mock('@/lib/guides/team-actions', async (orig) => {
  const real = await orig<typeof import('@/lib/guides/team-actions')>();
  return { ...real, respondGuideInvite: h.invite, leaveGuideTeam: h.leave };
});

const GUIDE = '12121212-1212-4121-8121-121212121212';
const REVIEW = 'abababab-1111-4222-8333-444444444444';
const FOREIGN_REVIEW = 'cdcdcdcd-1111-4222-8333-444444444444';
const DRAFT = 'dddddddd-1111-4222-8333-444444444444';
const INVITE = 'eeeeeeee-1111-4222-8333-444444444444';
const CHAT = 4242;

const { parseProfileEdit } = await import('@/lib/guides/chat-role/parse');
const { captureGuideRoleText, guideRolePress } = await import('@/lib/guides/chat-role/flow');
const { saveRoleDraft } = await import('@/lib/guides/chat-role/store');
const screens = await import('@/lib/guides/chat-role/screens');
const { certReminderLines } = await import('@/lib/guides/cert-reminders');
const { digestHasNews, digestText } = await import('@/lib/chat-cabinet/digest');
const { parseCabinetPress, cabinetPayload, CABINET_PAYLOAD_MAX_BYTES } = await import('@/lib/chat-cabinet/payload');
const replyRoute = await import('@/app/api/guide/reviews/[id]/reply/route');
const teamRoute = await import('@/app/api/guide/team/route');
const profileRoute = await import('@/app/api/guide/profile/route');

const GUIDE_CARD = {
  partnerId: GUIDE, userId: 'user-guide', category: 'guide', slug: 'g', sellsTours: false,
} as const;

// ── Поддельная база: черновик, отзыв, карточка ──────────────────────────────

interface Db {
  draft: Record<string, unknown> | null;
  review: { guide_reply: string | null } | null;
  awaiting: Record<string, unknown> | null;
  profile: Record<string, unknown> | null;
  writes: string[];
}
const db: Db = { draft: null, review: null, awaiting: null, profile: null, writes: [] };

function fake(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  const res = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return res([]);
  if (/^\s*(UPDATE|INSERT|DELETE)/.test(sql)) db.writes.push(sql.replace(/\s+/g, ' ').trim());
  if (/FROM guide_chat_drafts\s+WHERE id = \$1::uuid AND partner_id = \$2::uuid/.test(sql)) {
    return res(db.draft && params[1] === GUIDE && params[3] === String(CHAT) ? [db.draft] : []);
  }
  if (/FROM guide_chat_drafts d/.test(sql)) return res(db.awaiting ? [db.awaiting] : []);
  if (/SELECT guide_reply FROM guide_reviews WHERE id = \$1::uuid AND guide_id = \$2::uuid FOR UPDATE/.test(sql)) {
    return res(db.review && params[0] === REVIEW && params[1] === GUIDE ? [db.review] : []);
  }
  if (/FROM guide_reviews gr/.test(sql) && /WHERE gr\.id = \$2::uuid AND gr\.guide_id = \$1::uuid/.test(sql)) {
    return res(params[1] === REVIEW && params[0] === GUIDE
      ? [{ id: REVIEW, rating: 5, comment: 'Спасибо', author_name: 'Анна Петрова', is_public: true, guide_reply: db.review?.guide_reply ?? null, created_at: '2026-10-28' }]
      : []);
  }
  if (/^\s*UPDATE guide_reviews/.test(sql)) {
    return res(params.includes(REVIEW) ? [{ id: REVIEW, tourist_id: 'tourist-1', guide_id: GUIDE }] : []);
  }
  if (/FROM partners WHERE id = \$1::uuid AND category = 'guide'/.test(sql)) return res(db.profile ? [db.profile] : []);
  if (/^\s*UPDATE partners/.test(sql)) return res([], 1);
  if (/INSERT INTO guide_chat_drafts/.test(sql)) return res([{ id: DRAFT }]);
  if (/UPDATE guide_chat_drafts/.test(sql)) return res([], 1);
  return res([]);
}

beforeEach(() => {
  h.query.mockReset().mockImplementation(async (sql: string, params: unknown[]) => fake(sql, params));
  for (const f of [h.reply, h.profile, h.invite, h.leave]) f.mockReset();
  h.invite.mockResolvedValue({ kind: 'ok', operatorId: 'op-1' });
  h.leave.mockResolvedValue(true);
  db.draft = null;
  db.review = null;
  db.awaiting = null;
  db.profile = { name: 'Гид', profile_status: 'approved', description: 'Старое.', experience_years: null, languages: null };
  db.writes = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const who = (over: Partial<Parameters<typeof guideRolePress>[1]> = {}) => ({
  partner: GUIDE_CARD, owner: true, channel: 'max' as const, chatId: CHAT, nowMs: Date.UTC(2026, 9, 30), ...over,
});

const jsonReq = (url: string, method: string, body?: unknown) => new NextRequest(url, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

// ── Фраза профиля ───────────────────────────────────────────────────────────

describe('фраза профиля — правилами', () => {
  it('«о себе», «опыт», «языки» — правка; иное — не правка', () => {
    expect(parseProfileEdit('о себе: Вожу на вулканы.')).toEqual({ ok: true, field: 'description', value: 'Вожу на вулканы.' });
    expect(parseProfileEdit('Опыт работы: 12 лет')).toEqual({ ok: true, field: 'experience_years', value: 12 });
    expect(parseProfileEdit('опыт 7')).toEqual({ ok: true, field: 'experience_years', value: 7 });
    expect(parseProfileEdit('языки: русский, английский; Русский')).toEqual({ ok: true, field: 'languages', value: ['русский', 'английский'] });
    for (const not of ['Горелый: описание: текст', 'описание: текст', 'какой у меня опыт?', '/start', 'привет']) {
      expect(parseProfileEdit(not), not).toBeNull();
    }
  });

  it('то, что записать нельзя, — отказ с причиной, а не догадка', () => {
    expect(parseProfileEdit('опыт: 61')).toMatchObject({ ok: false, reason: 'bad_years' });
    expect(parseProfileEdit('опыт: много')).toMatchObject({ ok: false, reason: 'bad_years' });
    expect(parseProfileEdit('о себе:   ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(parseProfileEdit(`о себе: ${'х'.repeat(5001)}`)).toMatchObject({ ok: false, reason: 'too_long', max: 5000 });
  });
});

// ── Кнопки ──────────────────────────────────────────────────────────────────

describe('кнопки этапа 2: форма', () => {
  it('каждая сборка разбирается обратно и влезает в 64 байта; испорченная — не кнопка', () => {
    const forms: Array<[string, unknown]> = [
      [cabinetPayload.reviews(), { kind: 'reviews', page: 0 }],
      [cabinetPayload.reviews(3), { kind: 'reviews', page: 3 }],
      [cabinetPayload.review(REVIEW), { kind: 'review', reviewId: REVIEW }],
      [cabinetPayload.reviewReply(REVIEW), { kind: 'review_reply', reviewId: REVIEW }],
      [cabinetPayload.reviewDelete(REVIEW), { kind: 'review_delete', reviewId: REVIEW }],
      [cabinetPayload.draftSave(DRAFT), { kind: 'draft_save', draftId: DRAFT }],
      [cabinetPayload.draftCancel(DRAFT), { kind: 'draft_cancel', draftId: DRAFT }],
      [cabinetPayload.schedule(), { kind: 'schedule', page: 0 }],
      [cabinetPayload.schedule(2), { kind: 'schedule', page: 2 }],
      [cabinetPayload.earnings(), { kind: 'earnings' }],
      [cabinetPayload.profile(), { kind: 'profile' }],
      [cabinetPayload.inviteAccept(INVITE), { kind: 'invite_accept', inviteId: INVITE }],
      [cabinetPayload.inviteDecline(INVITE), { kind: 'invite_decline', inviteId: INVITE }],
      [cabinetPayload.teamLeave(), { kind: 'team_leave' }],
      [cabinetPayload.teamLeaveYes(), { kind: 'team_leave_yes' }],
    ];
    for (const [p, want] of forms) {
      expect(parseCabinetPress(p), p).toEqual(want);
      expect(Buffer.byteLength(p), p).toBeLessThanOrEqual(CABINET_PAYLOAD_MAX_BYTES);
    }
    for (const bad of ['cb:s:5', 'cb:a:q:' + REVIEW, 'cb:b:s:501', 'cb:p:a:', 'cb:p:z', 'cb:j:1', 'cb:a:100']) {
      expect(parseCabinetPress(bad), bad).toBeNull();
    }
  });
});

// ── Без кнопки не пишется ───────────────────────────────────────────────────

describe('без кнопки не пишется ничего', () => {
  it('текст после «Ответить» — только черновик: «было → станет», отзыв не тронут', async () => {
    db.awaiting = { id: DRAFT, partner_id: GUIDE, review_id: REVIEW, live_value: null, newer: false };
    const s = await captureGuideRoleText({ channel: 'max', chatId: CHAT, partner: GUIDE_CARD, text: 'Спасибо <за> отзыв!' });
    expect(s?.text).toContain('<b>Станет:</b>\nСпасибо &lt;за&gt; отзыв!');
    expect(s?.rows.flat().map((b) => b.text)).toEqual(expect.arrayContaining(['Опубликовать', 'Отмена']));
    expect(db.writes.filter((w) => /guide_reviews|partners/.test(w))).toEqual([]);
    expect(h.reply).not.toHaveBeenCalled();
  });

  it('длинный ответ — «пришлите короче», ожидание остаётся', async () => {
    db.awaiting = { id: DRAFT, partner_id: GUIDE, review_id: REVIEW, live_value: null, newer: false };
    const s = await captureGuideRoleText({ channel: 'max', chatId: CHAT, partner: GUIDE_CARD, text: 'х'.repeat(1001) });
    expect(s?.text).toMatch(/1001 знаков, а помещается 1000/);
    expect(db.writes).toEqual([]);
  });

  it('беда в тексте — своим путём, ответом не становится', async () => {
    db.awaiting = { id: DRAFT, partner_id: GUIDE, review_id: REVIEW, live_value: null, newer: false };
    expect(await captureGuideRoleText({ channel: 'max', chatId: CHAT, partner: GUIDE_CARD, text: 'помогите, турист сломал ногу' })).toBeNull();
    expect(db.writes.some((w) => /SET new_value/.test(w))).toBe(false);
  });

  it('«о себе: …» — только черновик, карточка не тронута', async () => {
    const s = await captureGuideRoleText({ channel: 'telegram', chatId: CHAT, partner: GUIDE_CARD, text: 'о себе: Новое о себе.' });
    expect(s?.text).toContain('Старое.');
    expect(s?.text).toContain('Новое о себе.');
    expect(db.writes.some((w) => /INSERT INTO guide_chat_drafts/.test(w))).toBe(true);
    expect(db.writes.some((w) => /^UPDATE partners/.test(w))).toBe(false);
    expect(h.profile).not.toHaveBeenCalled();
  });

  it('не гид и карточка без кабинета — не пишет', async () => {
    expect(await captureGuideRoleText({ channel: 'max', chatId: CHAT, partner: { ...GUIDE_CARD, category: 'operator' }, text: 'о себе: x' })).toBeNull();
    const s = await captureGuideRoleText({ channel: 'max', chatId: CHAT, partner: { ...GUIDE_CARD, userId: null }, text: 'о себе: x' });
    expect(s?.text).toMatch(/кабинетом на сайте/);
    expect(db.writes).toEqual([]);
  });
});

// ── Сайт и чат — одной функцией ─────────────────────────────────────────────

describe('сайт и чат пишут одной функцией', () => {
  it('ответ на отзыв: роут (POST/PUT/DELETE) и «Опубликовать» зовут writeGuideReviewReply', async () => {
    const params = { params: Promise.resolve({ id: REVIEW }) };
    expect((await replyRoute.POST(jsonReq(`http://x/api/guide/reviews/${REVIEW}/reply`, 'POST', { reply: 'Спасибо' }), params)).status).toBe(200);
    expect((await replyRoute.PUT(jsonReq(`http://x/api/guide/reviews/${REVIEW}/reply`, 'PUT', { reply: 'Ещё раз' }), params)).status).toBe(200);
    expect((await replyRoute.DELETE(jsonReq(`http://x/api/guide/reviews/${REVIEW}/reply`, 'DELETE'), params)).status).toBe(200);
    expect(h.reply.mock.calls.map((c) => [c[0].action, c[0].owner])).toEqual([
      ['post', { userId: 'user-guide' }], ['update', { userId: 'user-guide' }], ['delete', { userId: 'user-guide' }],
    ]);
    h.reply.mockClear();
    db.review = { guide_reply: null };
    db.draft = { id: DRAFT, kind: 'reply', review_id: REVIEW, field: null, new_value: 'Спасибо!', live_value: null, status: 'pending', expired: false };
    const r = await saveRoleDraft({ partnerId: GUIDE, channel: 'max', chatId: CHAT, draftId: DRAFT });
    expect(r.kind).toBe('saved');
    expect(h.reply.mock.calls.map((c) => c[0])).toEqual([{ owner: { partnerId: GUIDE }, reviewId: REVIEW, action: 'post', reply: 'Спасибо!' }]);
    // Уведомление туристу — то же, что у сайта.
    expect(db.writes.some((w) => /INSERT INTO notifications .*'guide_reply'.*'normal'\)/.test(w))).toBe(true);
  });

  it('ответ на отзыв: «было» поменяли после предпросмотра — не пишет; чужой чат — «не найден»', async () => {
    db.review = { guide_reply: 'Правка на сайте' };
    db.draft = { id: DRAFT, kind: 'reply', review_id: REVIEW, field: null, new_value: 'Новое', live_value: null, status: 'pending', expired: false };
    expect((await saveRoleDraft({ partnerId: GUIDE, channel: 'max', chatId: CHAT, draftId: DRAFT })).kind).toBe('changed');
    expect((await saveRoleDraft({ partnerId: GUIDE, channel: 'max', chatId: CHAT + 1, draftId: DRAFT })).kind).toBe('not_found');
    expect(h.reply).not.toHaveBeenCalled();
    expect(db.writes.some((w) => /^UPDATE guide_reviews/.test(w))).toBe(false);
  });

  it('чужой отзыв: «Ответить» — «не найден», черновика нет', async () => {
    const s = await guideRolePress({ kind: 'review_reply', reviewId: FOREIGN_REVIEW }, who());
    expect(s.text).toMatch(/не найден среди отзывов о вас/);
    expect(db.writes).toEqual([]);
  });

  it('профиль: роут PUT и «Сохранить» зовут writeGuideProfilePatch', async () => {
    const res = await profileRoute.PUT(jsonReq('http://x/api/guide/profile', 'PUT', { description: 'С сайта' }));
    expect(res.status).toBe(200);
    expect(h.profile.mock.calls[0]![0]).toMatchObject({ partnerId: GUIDE, patch: { description: 'С сайта' } });
    h.profile.mockClear();
    db.draft = { id: DRAFT, kind: 'profile', review_id: null, field: 'description', new_value: 'Из чата', live_value: 'Старое.', status: 'pending', expired: false };
    expect((await saveRoleDraft({ partnerId: GUIDE, channel: 'max', chatId: CHAT, draftId: DRAFT })).kind).toBe('saved');
    expect(h.profile.mock.calls[0]![0]).toMatchObject({ partnerId: GUIDE, patch: { description: 'Из чата' } });
  });

  it('команда: роут POST/DELETE и кнопки «Принять», «Выйти» зовут respondGuideInvite и leaveGuideTeam', async () => {
    expect((await teamRoute.POST(jsonReq('http://x/api/guide/team', 'POST', { inviteId: INVITE, action: 'accept' }))).status).toBe(200);
    await guideRolePress({ kind: 'invite_accept', inviteId: INVITE }, who());
    await guideRolePress({ kind: 'invite_decline', inviteId: INVITE }, who());
    expect(h.invite.mock.calls).toEqual([[GUIDE, INVITE, 'accept'], [GUIDE, INVITE, 'accept'], [GUIDE, INVITE, 'decline']]);
    expect((await teamRoute.DELETE(jsonReq('http://x/api/guide/team', 'DELETE'))).status).toBe(200);
    // «Выйти» — сначала вопрос, ничего не пишет; пишет только «Да, выйти».
    const ask = await guideRolePress({ kind: 'team_leave' }, who());
    expect(h.leave).toHaveBeenCalledTimes(1);
    expect(ask.text).toMatch(/Вы не в команде|Выйти из команды/);
    await guideRolePress({ kind: 'team_leave_yes' }, who());
    expect(h.leave.mock.calls).toEqual([[GUIDE], [GUIDE]]);
  });

  it('менеджер команды и чужая роль — отказ без записи', async () => {
    for (const w of [who({ owner: false }), who({ partner: { ...GUIDE_CARD, category: 'operator' } })]) {
      const s = await guideRolePress({ kind: 'invite_accept', inviteId: INVITE }, w);
      expect(s.text).toMatch(/раздел кабинета гида/);
    }
    expect(h.invite).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});

// ── Каналы и «не знаю» ──────────────────────────────────────────────────────

describe('экраны: ПД только в MAX, «нет данных» ≠ «не загрузилось»', () => {
  const review = { id: REVIEW, rating: 4, comment: 'Хорошо', author: 'Анна П.', isPublic: true, reply: null, createdAt: '2026-10-28' };

  it('отзыв: подпись автора — в MAX (экран с ПД), в Telegram её нет', () => {
    const max = screens.reviewScreen({ review, channel: 'max' });
    expect(max.text).toContain('Анна П.');
    expect(max.pd).toBe(true);
    const tg = screens.reviewScreen({ review, channel: 'telegram' });
    expect(tg.text).not.toContain('Анна');
    expect(tg.pd).toBe(false);
  });

  it('расписание: имена и телефоны группы — только в MAX', () => {
    const schedule = { schedule: [], assignments: [{ bookingId: '1', date: '2026-11-02', tourTitle: 'Авача', participants: 2, status: 'confirmed' }] };
    const group = {
      key: 'k', date: '2026-11-02', tourId: '1', tourTitle: 'Авача', meetingPoint: 'Площадь', operatorName: 'Оператор', totalParticipants: 2,
      bookings: [{ bookingId: '1', status: 'confirmed', participants: 2, touristName: 'Иван Турист', touristPhone: '+70000000001', specialRequests: null, endDate: null }],
    };
    const base = { from: '2026-10-30', to: '2026-11-12', page: 0, schedule, siteBase: 'https://x' };
    const max = screens.scheduleScreen({ ...base, channel: 'max', groups: { inTeam: true, groups: [group] } });
    expect(max.text).toContain('Иван Турист, +70000000001');
    expect(max.pd).toBe(true);
    const tg = screens.scheduleScreen({ ...base, channel: 'telegram', groups: null });
    expect(tg.text).toContain('Группа: Авача — 2 чел., броней 1');
    expect(tg.text).not.toContain('Иван');
    expect(tg.pd).toBe(false);
  });

  it('заработок: начислений нет — не «0 ₽»; база не ответила — «не прочитался»', async () => {
    const none = screens.earningsScreen({
      period: '30d', items: [],
      summary: { count: 0, totalEarnings: null, paid: null, pendingPayment: null, toursWithEarnings: null, averagePerItem: null },
    }, 'https://x');
    expect(none.text).toMatch(/это не «заработано 0 ₽»/);
    h.query.mockImplementation(async () => { throw Object.assign(new Error('x'), { code: '57P01' }); });
    const failed = await guideRolePress({ kind: 'earnings' }, who());
    expect(failed.text).toMatch(/не прочитался/);
    expect(failed.failed).toBe(true);
  });
});

// ── Срок аттестата в сводке ─────────────────────────────────────────────────

describe('срок аттестата — строка сводки за 30, 7 и 1 день', () => {
  const cert = (expiryDate: string | null, review: 'verified' | 'pending' | 'rejected' = 'verified', issueDate = '2025-01-10') => ({
    id: 'c', name: 'Инструктор <проводник>', issuingAuthority: 'ФСТР', certificateNumber: 'N', issueDate, expiryDate,
    review, reviewComment: null, source: 'guide',
  });

  it('ровно за 30, 7 и 1 день — строка; в другие дни, без срока и у отклонённого — нет', () => {
    expect(certReminderLines([cert('2026-11-29')], '2026-10-30')).toEqual([
      'Аттестат «Инструктор &lt;проводник&gt;» истекает через 30 дней, 29.11. Новый — в кабинете на сайте, раздел «Аттестаты».',
    ]);
    expect(certReminderLines([cert('2026-11-06')], '2026-10-30')[0]).toMatch(/через 7 дней, 06\.11/);
    expect(certReminderLines([cert('2026-10-31')], '2026-10-30')[0]).toMatch(/завтра, 31\.10/);
    for (const today of ['2026-10-29', '2026-11-04', '2026-11-07']) expect(certReminderLines([cert('2026-11-06')], today)).toEqual([]);
    expect(certReminderLines([cert(null)], '2026-10-30')).toEqual([]);
    expect(certReminderLines([cert('2026-11-06', 'rejected')], '2026-10-30')).toEqual([]);
  });

  it('переаттестация: нужна и до срока 7 дней — строка; срок прошёл — нет', () => {
    const old = [cert(null, 'verified', '2023-05-01')];
    expect(certReminderLines(old, '2026-09-24')).toEqual([
      'Переаттестация инструктора-проводника — срок через 7 дней, 01.10. Аттестата новее 01.07.2024 в кабинете нет.',
    ]);
    expect(certReminderLines(old, '2026-10-30')).toEqual([]);
  });

  it('сводка: строка аттестата — новость сама по себе; «не прочитались» — только при другой новости', () => {
    const inbox = { category: 'guide', items: [], failed: [], not_here: [], chat: { state: 'none' }, response: { window_days: 30, median_minutes: null, responded: 0, enough: false, complete: true } };
    const facts = { inbox, due: [], overdue: 0, certs: ['Аттестат «А» истекает завтра, 31.10.'] } as unknown as Parameters<typeof digestHasNews>[0];
    expect(digestHasNews(facts)).toBe(true);
    expect(digestText(facts, 'telegram', Date.UTC(2026, 9, 30))).toContain('Аттестат «А» истекает завтра');
    expect(digestHasNews({ ...facts, certs: null })).toBe(false);
    expect(digestHasNews({ ...facts, certs: [] })).toBe(false);
  });
});
