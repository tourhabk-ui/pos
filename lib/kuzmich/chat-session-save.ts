/**
 * Запись разговора веб-чата Кузьмича в chat_sessions — одна на оба входа
 * (/api/ai/chat и /api/ai/chat-stream): правило, написанное дважды, — это
 * два правила, и они разойдутся (§12).
 *
 * ── Хозяин сессии (#2327, ревью третьего круга) ──────────────────────────
 *
 * Чат начинается анонимным (FREE_MESSAGE_LIMIT сообщений до входа), и после
 * входа человек продолжает ТУ ЖЕ сессию: ключ th_kuzmich_session живёт в его
 * браузере. Прежде ON CONFLICT хозяина не записывал: строка, вставленная
 * анонимно с user_id NULL, оставалась ничьей навсегда, хотя is_authenticated
 * становился true. Удаление аккаунта (lib/account/erase.ts) ищет переписку по
 * user_id — и не находило ту, где он после входа называл телефон и диагноз,
 * а ответ при этом говорил «стёрты».
 *
 * Теперь на конфликте user_id = COALESCE(записанный, новый): ничья сессия
 * получает хозяина с первым сообщением после входа, а записанного хозяина
 * запись не меняет никогда. Чужую сессию сюда не пускает вызывающий
 * (isForeignSession в обоих роутах): сессия, за которой записан другой
 * аккаунт, не читается и не перезаписывается.
 *
 * Ничья сессия по-прежнему открыта тому, кто знает её id (иначе анонимную
 * беседу не продолжить), и первый вошедший с этим id становится её хозяином.
 * id непредсказуем (crypto, tests/unit/chat-session-isolation.test.ts), так
 * что это не угадывание, а общий браузер: вошедший видел бы ту же историю и
 * раньше; теперь она вдобавок его — и стирается с его аккаунтом.
 *
 * Отказ записи не роняет ответ человеку (разговор важнее журнала), но и не
 * глушится: имя шага и SQLSTATE — в лог (§4.0).
 */
import { query } from '@/lib/database';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

/** Сколько последних реплик хранится в сессии. */
export const CHAT_SESSION_KEEP_MESSAGES = 20;

export const SAVE_CHAT_SESSION_SQL = `INSERT INTO chat_sessions
         (session_id, user_id, role, messages, user_message_count, is_authenticated,
          interests_encrypted, referrer_source, utm_source, utm_medium, utm_campaign, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (session_id) DO UPDATE
         SET messages               = $4::jsonb,
             user_message_count     = $5,
             is_authenticated       = $6,
             user_id                = COALESCE(chat_sessions.user_id, EXCLUDED.user_id),
             interests_encrypted    = COALESCE($7, chat_sessions.interests_encrypted),
             referrer_source        = COALESCE(chat_sessions.referrer_source, $8),
             utm_source             = COALESCE(chat_sessions.utm_source, $9),
             utm_medium             = COALESCE(chat_sessions.utm_medium, $10),
             utm_campaign           = COALESCE(chat_sessions.utm_campaign, $11),
             updated_at             = NOW(),
             role                   = $3`;

export interface ChatSessionSave {
  sessionId: string;
  /** Вошедший человек; null — аноним. */
  userId: string | null;
  role: string;
  messages: unknown[];
  userMessageCount: number;
  isAuthenticated: boolean;
  interestsEncrypted: string | null;
  /** Откуда пришёл — пишется только в первую запись сессии. */
  utm?: { referrerSource?: string; utmSource?: string; utmMedium?: string; utmCampaign?: string };
}

export async function saveChatSession(s: ChatSessionSave): Promise<void> {
  if (!s.sessionId) return;
  const trimmed = s.messages.slice(-CHAT_SESSION_KEEP_MESSAGES);
  try {
    await query(SAVE_CHAT_SESSION_SQL, [
      s.sessionId, s.userId, s.role, JSON.stringify(trimmed), s.userMessageCount, s.isAuthenticated,
      s.interestsEncrypted,
      s.utm?.referrerSource ?? null, s.utm?.utmSource ?? null,
      s.utm?.utmMedium ?? null, s.utm?.utmCampaign ?? null,
    ]);
  } catch (err) {
    logSwallowedFailure('kuzmich/chat-session', 'запись сессии веб-чата', err);
  }
}
