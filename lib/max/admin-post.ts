/**
 * Пост в канал из MAX администратора — фаза 2г. Владелец 23.10 ответил
 * «1a 2б» на вариант «б) следующим шагом — действия, каждое с кнопкой
 * подтверждения: открыть даты любого тура за оператора; пост в канал; смена
 * статуса заявки или брони»; 07.11 — «Just do it» по схеме карточек
 * подтверждения.
 *
 * ── Поток ──────────────────────────────────────────────────────────────────
 *
 *   1. «пост» и текст — с новой строки, после двоеточия или пробела:
 *      «пост\nОткрыли даты на Горелый: 12 и 14 декабря». Текст — слово в
 *      слово администратора: модели здесь нет, подписи «написал ИИ» тоже.
 *      Фото, видео и файл с подписью «пост …» — отказ словами: молча
 *      опубликовать подпись без снимка значило бы выдать не тот пост.
 *      Первое слово решает: текст поста может говорить о датах, бронях и
 *      турах, и его не забирают ни разбор дат и команд (lib/max/admin-chat),
 *      ни Кузьмич туриста (роут MAX), ни кабинет партнёра в общем чате
 *      (lib/roles/admin-partner-chat).
 *   2. До вопроса — та же проверка, что у всех постов канала
 *      (validateTextPost: длина 30–2000, не больше четырёх хэштегов и эмодзи,
 *      заглушки, живость ссылок). Не прошла — отказ словами, ничего не
 *      записано, прежний вопрос чата снят.
 *   3. Вопрос — ровно то, что уйдёт в Telegram, и «Да, опубликовать» /
 *      «Не надо». Телефон или почта в тексте — предупреждение: канал
 *      открытый. До «Да» ничего не уходит, вопрос живёт 15 минут, новый
 *      вопрос в чате снимает прежний.
 *   4. «Да» — захват строки одним UPDATE, как у прочих вопросов; права
 *      администратора — на этом нажатии (lib/max/admin-actions). Публикация —
 *      единственным путём канала (postAdminText → postToAllChannels):
 *      проверка ещё раз, Telegram, MAX с ожиданием ответа. Исход по каждому
 *      каналу — в строку (admin_chat_actions, миграция 1403) и
 *      администратору словами; повтор «Да» отвечает прежним итогом.
 *
 * ПД: в строке вопроса — только текст поста, который администратор сам
 * отправляет в открытый канал. Отказ базы — имя проверки и SQLSTATE в лог.
 *
 * Сторож: tests/integration/max-login-confirm.pg.test.ts — путь целиком на
 * схеме прода и настоящем обработчике бота.
 */

import { pool } from '@/lib/db-pool';
import { escapeHtml } from '@/lib/text/escape-html';
import { escHtml } from '@/lib/notifications/channel-style';
import { hasPII } from '@/lib/security/pii-redact';
import type { AdminPostResult, ChannelMark } from '@/lib/notifications/telegram-channel';
import {
  ADMIN_ACTION_TEXT, ADMIN_ACTION_TTL_MIN, type AdminActionReply, type BlockedWords,
  adminActionReply as reply, adminAnswerPayload, blockedText, readState,
} from '@/lib/max/admin-actions';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

/** Отказ — в лог: имя проверки и SQLSTATE. Текст ошибки не пишется — в нём бывают значения строки. */
function logFail(check: string, err: unknown): void {
  console.error(`[max/admin-post] ${check} — отказ, SQLSTATE ${sqlstate(err)}`);
}

export const ADMIN_POST_TEXT = {
  how: 'Напишите «пост» и с новой строки текст — покажу, как он выйдет в канале, и спрошу «Да». Ничего не опубликовано.',
  noChannel: 'Канал Telegram не настроен на сервере — публиковать некуда. Ничего не опубликовано.',
  cancelled: 'Хорошо, пост не публикую.',
  retireFailed: 'Прежний вопрос снять не смог — его кнопку «Да» не нажимайте.',
  pd: 'Внимание: в тексте телефон или почта. Канал открытый — их увидят все. Публикуйте, только если это не контакт туриста.',
  unknown: 'Не знаю, ушёл ли пост: публикация оборвалась. Проверьте канал, прежде чем присылать «пост» снова.',
  media: 'Фото, видео и файлы к посту пока не беру — пришлите пост одним текстом. Ничего не опубликовано.',
} as const;

// ── Разбор ───────────────────────────────────────────────────────────────────

/**
 * Голова команды: «пост» или «пост в канал»; дальше — двоеточие, тире,
 * пробел, перенос строки или конец. «Постановление», «пост-релиз» — не она.
 */
const POST_HEAD = /^\s*пост(?:\s+в\s+канал)?(?:\s*[:—–]\s*|\s+|$)/iu;

/** Текст поста из сообщения администратора; '' — «пост» без текста; null — это не пост. */
export function adminPostBody(text: string): string | null {
  const m = POST_HEAD.exec(text);
  return m ? text.slice(m[0].length).trim() : null;
}

/** Сообщение — команда поста (с текстом или без): его не берут ни Кузьмич туриста, ни кабинет партнёра. */
export function isAdminPostText(text: string): boolean {
  return adminPostBody(text) !== null;
}

// ── Вопрос ───────────────────────────────────────────────────────────────────

async function retireLive(adminUserId: string, chatId: number): Promise<number | null> {
  try {
    const r = await pool.query(
      `UPDATE admin_chat_actions SET status = 'superseded'
        WHERE admin_user_id = $1::uuid AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
      [adminUserId, String(chatId)],
    );
    return r.rowCount ?? 0;
  } catch (err) {
    logFail('снятие прежнего вопроса', err);
    return null;
  }
}

/** Отказ на новое сообщение снимает и прежний вопрос: его «Да» под чужим текстом не нажмут по ошибке. */
async function answerRetiring(adminUserId: string, chatId: number, text: string): Promise<AdminActionReply> {
  const n = await retireLive(adminUserId, chatId);
  return reply(n === null ? `${text}\n${ADMIN_POST_TEXT.retireFailed}` : text);
}

/** Новый вопрос одной транзакцией: прежний живой вопрос чата снимается, новый вставляется. */
async function insertQuestion(adminUserId: string, chatId: number, html: string): Promise<string | null> {
  const client = await pool.connect().catch((err: unknown) => {
    logFail('соединение для вопроса о посте', err);
    return null;
  });
  if (!client) return null;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE admin_chat_actions SET status = 'superseded'
        WHERE admin_user_id = $1::uuid AND chat_id = $2::bigint AND status IN ('draft', 'ready')`,
      [adminUserId, String(chatId)],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO admin_chat_actions
         (admin_user_id, channel, chat_id, subject_kind, subject_id, action, status, expires_at, params)
       VALUES ($1::uuid, 'max', $2::bigint, 'post', NULL, 'publish', 'ready',
               NOW() + make_interval(mins => $3::int), $4::jsonb)
       RETURNING id::text AS id`,
      [adminUserId, String(chatId), ADMIN_ACTION_TTL_MIN, JSON.stringify({ text: html })],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (err) {
    logFail('новый вопрос о посте', err);
    await client.query('ROLLBACK').catch((e: unknown) => logFail('откат вопроса о посте', e));
    return null;
  } finally {
    client.release();
  }
}

function previewText(telegramHtml: string, warnings: readonly string[], pd: boolean, toMax: boolean): string {
  const lines = [
    'Так выйдет в канале:',
    '',
    telegramHtml,
    '',
    '———',
    toMax
      ? 'Куда: канал Ведара в Telegram и в MAX.'
      : 'Куда: канал Ведара в Telegram. Канал в MAX не настроен на сервере — туда не уйдёт.',
  ];
  if (pd) lines.push(ADMIN_POST_TEXT.pd);
  for (const w of warnings) lines.push(`Проверка: ${escapeHtml(w)}.`);
  lines.push(`Опубликовать? До «Да» ничего не уходит. Вопрос живёт ${ADMIN_ACTION_TTL_MIN} минут.`);
  return lines.join('\n');
}

/**
 * Сообщение администратора: «пост» и текст → вопрос с превью. null — это не
 * пост, дальше разбирают даты и команды.
 */
export async function handleAdminPostText(opts: {
  adminUserId: string;
  chatId: number;
  text: string;
  /** К сообщению приложены фото, видео или файл: подпись «пост …» без них ушла бы молча. */
  hasMedia?: boolean;
}): Promise<AdminActionReply | null> {
  const body = adminPostBody(opts.text);
  if (body === null) return null;
  const { adminUserId, chatId } = opts;
  if (opts.hasMedia) return answerRetiring(adminUserId, chatId, ADMIN_POST_TEXT.media);
  if (!body) return answerRetiring(adminUserId, chatId, ADMIN_POST_TEXT.how);
  const channel = await import('@/lib/notifications/telegram-channel');
  const targets = channel.adminPostChannels();
  if (!targets.telegram) return answerRetiring(adminUserId, chatId, ADMIN_POST_TEXT.noChannel);

  // Текст человека — как написан: экранируются только знаки разметки.
  const html = escHtml(body);
  const { validateTextPost } = await import('@/lib/notifications/post-validation');
  const check = await validateTextPost(html);
  if (!check.valid) {
    const why = check.errors.map((e) => escapeHtml(e)).join('; ');
    return answerRetiring(adminUserId, chatId, `Не публикую: ${why}. Исправьте текст и пришлите «пост» снова. Ничего не опубликовано.`);
  }
  const id = await insertQuestion(adminUserId, chatId, html);
  if (!id) return reply(ADMIN_ACTION_TEXT.notSaved);
  return reply(
    previewText(channel.crossLinkedTexts(html).telegram, check.warnings, hasPII(body), targets.max),
    [[
      { text: 'Да, опубликовать', payload: adminAnswerPayload(true, id), intent: 'positive' },
      { text: 'Не надо', payload: adminAnswerPayload(false, id) },
    ]],
  );
}

// ── «Да» / «Не надо» ─────────────────────────────────────────────────────────

/** Итог в строке вопроса — им же отвечает повтор. */
type StoredOutcome =
  | { kind: 'post_done'; telegram: ChannelMark; max: ChannelMark }
  | { kind: 'post_refused'; reason: 'check'; detail: string }
  | { kind: 'post_refused'; reason: 'not_configured' }
  | { kind: 'post_refused'; reason: 'failed'; telegram: string; max: string }
  | { kind: 'post_refused'; reason: 'error' };

function markOf(v: unknown): ChannelMark | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.ok === true) return { ok: true };
  if (o.ok === false && typeof o.error === 'string') return { ok: false, error: o.error };
  return null;
}

function readStored(v: unknown): StoredOutcome | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'post_done') {
    const telegram = markOf(o.telegram);
    const max = markOf(o.max);
    return telegram && max ? { kind: 'post_done', telegram, max } : null;
  }
  if (o.kind !== 'post_refused') return null;
  if (o.reason === 'check' && typeof o.detail === 'string') return { kind: 'post_refused', reason: 'check', detail: o.detail };
  if (o.reason === 'not_configured') return { kind: 'post_refused', reason: 'not_configured' };
  if (o.reason === 'failed' && typeof o.telegram === 'string' && typeof o.max === 'string') {
    return { kind: 'post_refused', reason: 'failed', telegram: o.telegram, max: o.max };
  }
  if (o.reason === 'error') return { kind: 'post_refused', reason: 'error' };
  return null;
}

function storedFrom(r: AdminPostResult): StoredOutcome {
  if (r.kind === 'not_configured') return { kind: 'post_refused', reason: 'not_configured' };
  if (r.kind === 'refused') return { kind: 'post_refused', reason: 'check', detail: r.reason };
  if (r.telegram.ok || r.max.ok) return { kind: 'post_done', telegram: r.telegram, max: r.max };
  return { kind: 'post_refused', reason: 'failed', telegram: r.telegram.error, max: r.max.error };
}

function adminPostOutcomeText(o: StoredOutcome): string {
  if (o.kind === 'post_done') {
    const { telegram: tg, max } = o;
    if (tg.ok && max.ok) return 'Опубликовано в канале Ведара в Telegram и в MAX.';
    if (tg.ok && !max.ok) return `Опубликовано в Telegram. В MAX не ушло: ${escapeHtml(max.error)} — выложите там сами.`;
    if (!tg.ok && max.ok) return `Опубликовано в MAX. В Telegram не ушло: ${escapeHtml(tg.error)} — выложите там сами.`;
  }
  if (o.kind === 'post_refused') {
    if (o.reason === 'check') return `Не опубликовано: ${escapeHtml(o.detail)}. Исправьте текст и пришлите «пост» снова.`;
    if (o.reason === 'not_configured') return ADMIN_POST_TEXT.noChannel;
    if (o.reason === 'failed') {
      return `Не опубликовано ни в Telegram (${escapeHtml(o.telegram)}), ни в MAX (${escapeHtml(o.max)}). `
        + 'Пришлите «пост» снова чуть позже.';
    }
  }
  return ADMIN_POST_TEXT.unknown;
}

const POST_BLOCKED: BlockedWords = {
  again: 'пришлите «пост» и текст ещё раз',
  outcome: (v) => {
    const o = readStored(v);
    return o ? adminPostOutcomeText(o) : null;
  },
  checkWhere: 'в канале',
};

function readText(v: unknown): string | null {
  const t = v && typeof v === 'object' ? (v as Record<string, unknown>).text : null;
  return typeof t === 'string' && t.trim() ? t : null;
}

/** Итог в ту же строку: ровно одна захваченная строка, иначе — в лог. */
async function finish(actionId: string, status: 'done' | 'refused', outcome: StoredOutcome): Promise<void> {
  try {
    const upd = await pool.query(
      `UPDATE admin_chat_actions SET status = $2, outcome = $3::jsonb
        WHERE id = $1::uuid AND status = 'running'`,
      [actionId, status, JSON.stringify(outcome)],
    );
    if (upd.rowCount !== 1) console.error(`[max/admin-post] итог записан в ${upd.rowCount ?? 0} строк вместо одной`);
  } catch (err) {
    logFail('итог вопроса о посте', err);
  }
}

/** «Да» / «Не надо» под вопросом о посте. Права администратора проверил вход (lib/max/admin-actions). */
export async function answerPost(adminUserId: string, chatId: number, actionId: string, yes: boolean): Promise<AdminActionReply> {
  if (!yes) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE admin_chat_actions SET status = 'cancelled'
          WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
            AND subject_kind = 'post' AND status = 'ready'`,
        [actionId, adminUserId, String(chatId)],
      );
      if (rowCount === 1) return reply(ADMIN_POST_TEXT.cancelled);
    } catch (err) {
      logFail('«Не надо» под постом', err);
      return reply(ADMIN_ACTION_TEXT.unchecked);
    }
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, POST_BLOCKED));
  }

  // Захват: одна строка, этого чата и ЭТОГО администратора, готовая и не истёкшая.
  let claimed: { params: unknown } | undefined;
  try {
    const { rows } = await pool.query<{ params: unknown }>(
      `UPDATE admin_chat_actions SET status = 'running', used_at = NOW()
        WHERE id = $1::uuid AND admin_user_id = $2::uuid AND chat_id = $3::bigint
          AND subject_kind = 'post' AND status = 'ready' AND expires_at > NOW()
        RETURNING params`,
      [actionId, adminUserId, String(chatId)],
    );
    claimed = rows[0];
  } catch (err) {
    logFail('захват «Да» под постом', err);
    return reply(ADMIN_ACTION_TEXT.unchecked);
  }
  if (!claimed) {
    const st = await readState(adminUserId, chatId, actionId);
    return reply(st === 'unavailable' ? ADMIN_ACTION_TEXT.unchecked : blockedText(st, POST_BLOCKED));
  }

  const html = readText(claimed.params);
  let stored: StoredOutcome;
  if (!html) {
    console.error('[max/admin-post] вопрос о посте без текста — не исполнен');
    stored = { kind: 'post_refused', reason: 'error' };
  } else {
    try {
      const { postAdminText } = await import('@/lib/notifications/telegram-channel');
      stored = storedFrom(await postAdminText(html));
    } catch (err) {
      // Отказ мог случиться и после отправки — «не знаю», а не «не ушло».
      logFail('публикация поста администратора', err);
      stored = { kind: 'post_refused', reason: 'error' };
    }
  }
  await finish(actionId, stored.kind === 'post_done' ? 'done' : 'refused', stored);
  return reply(adminPostOutcomeText(stored));
}
