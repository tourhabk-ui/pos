/**
 * lib/agents/ai-channel-access.ts — может ли бот публиковать в AI-канал.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────
 *
 * Канал @ai_hub_money молчал, и подозреваемых было два: не задан
 * TELEGRAM_AI_CHANNEL_ID или заданный ID недостижим для бота. Первое сняли
 * глазами (29.08, переменная на месте). Второе глазами не снимается: ID
 * может быть верным, а бот — не админом канала или без права публикации, и
 * тогда отправка падает на каждом прогоне.
 *
 * Ждать очередного дайджеста, чтобы это выяснить, — неделя на вопрос,
 * который решается двумя запросами к Telegram.
 *
 * ── Чего здесь НЕТ намеренно ─────────────────────────────────────────────
 *
 * Пробной публикации. В канале сорок тысяч подписчиков, и «тестовое
 * сообщение» там — это сообщение, которое увидят сорок тысяч человек.
 * Проверка идёт ТОЛЬКО чтением: getChat и getChatMember. Право публиковать
 * Telegram сообщает сам, посылать ничего не нужно.
 *
 * Сеть живёт в роуте; здесь чистый разбор ответов — его судят тесты.
 */

/** Что именно выяснили. Три исхода, и «не смог проверить» — отдельный (§4.0). */
export type ChannelAccess =
  /** Бот в канале и вправе публиковать. */
  | { kind: 'can_post'; title: string | null }
  /** Канал достижим, но публиковать бот не может — с названной причиной. */
  | { kind: 'cannot_post'; reason: string; title: string | null }
  /** Проверка не состоялась: нет токена, нет ID, Telegram не ответил. */
  | { kind: 'unknown'; reason: string };

/** Ответ Telegram в той форме, в какой он нужен разбору. */
export interface TgResponse {
  ok?: unknown;
  description?: unknown;
  error_code?: unknown;
  result?: unknown;
}

function describeTgError(res: TgResponse | null, fallback: string): string {
  if (!res) return fallback;
  const desc = typeof res.description === 'string' ? res.description : null;
  const code = typeof res.error_code === 'number' ? res.error_code : null;
  if (desc && code) return `Telegram ${code}: ${desc}`;
  if (desc) return `Telegram: ${desc}`;
  return fallback;
}

/**
 * Разбор пары ответов: getChat (канал вообще виден боту?) и getChatMember
 * (кто в нём бот и что ему можно?).
 *
 * `chat` = null означает, что запрос не состоялся вовсе — это `unknown`, а
 * не «нельзя публиковать»: недоступность Telegram и запрет публикации ведут
 * к разным действиям, и путать их нельзя.
 */
export function readChannelAccess(chat: TgResponse | null, member: TgResponse | null): ChannelAccess {
  if (!chat) return { kind: 'unknown', reason: 'запрос getChat не состоялся' };

  const chatResult = (typeof chat.result === 'object' && chat.result !== null ? chat.result : {}) as {
    title?: unknown;
  };
  const title = typeof chatResult.title === 'string' ? chatResult.title : null;

  if (chat.ok !== true) {
    // Самая частая беда — неверный ID или бот не добавлен в канал. Telegram
    // отвечает «chat not found», и это ФАКТ о доступе, а не сбой проверки.
    return { kind: 'cannot_post', reason: describeTgError(chat, 'канал недоступен боту'), title };
  }

  if (!member) return { kind: 'unknown', reason: 'запрос getChatMember не состоялся', };

  if (member.ok !== true) {
    return { kind: 'cannot_post', reason: describeTgError(member, 'не удалось узнать роль бота'), title };
  }

  const m = (typeof member.result === 'object' && member.result !== null ? member.result : {}) as {
    status?: unknown;
    can_post_messages?: unknown;
  };
  const status = typeof m.status === 'string' ? m.status : 'unknown';

  if (status === 'left' || status === 'kicked') {
    return { kind: 'cannot_post', reason: `бот не состоит в канале (статус ${status})`, title };
  }

  if (status === 'creator') return { kind: 'can_post', title };

  if (status === 'administrator') {
    // У канала право публикации — ОТДЕЛЬНОЕ: админ без него молча не сможет
    // отправить пост. Telegram присылает флаг только для каналов; если его
    // нет вовсе, судить нечего — это `unknown`, а не «можно».
    if (m.can_post_messages === true) return { kind: 'can_post', title };
    if (m.can_post_messages === false) {
      return { kind: 'cannot_post', reason: 'бот админ, но без права публиковать сообщения', title };
    }
    return { kind: 'unknown', reason: 'Telegram не сообщил право публикации у админа' };
  }

  // member/restricted — для канала это подписчик, публиковать он не может.
  return { kind: 'cannot_post', reason: `бот в канале как ${status}, публиковать не вправе`, title };
}

/** Строка для отчёта: исход обязан читаться без раскрытия JSON. */
export function describeAccess(a: ChannelAccess): string {
  switch (a.kind) {
    case 'can_post':
      return `бот вправе публиковать${a.title ? ` в «${a.title}»` : ''}`;
    case 'cannot_post':
      return `публиковать НЕ может: ${a.reason}`;
    case 'unknown':
      return `не смог проверить: ${a.reason}`;
  }
}
