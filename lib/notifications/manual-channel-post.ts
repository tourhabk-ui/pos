/**
 * Ручной пост в публичный канал через бота (@kuzmichai_bot).
 *
 * Владелец пишет пост (или утверждает написанный), содержимое кладётся в
 * .github/triggers/channel-post.json, workflow channel-post.yml доставляет его
 * на прод-эндпоинт /api/cron/channel-post — токен бота есть только на проде.
 *
 * Обложка — тот же детерминированный механизм, что у автоматических постов
 * (lib/notifications/post-image.ts): сюжет/стиль/палитра и seed от хэша текста,
 * либо явные imagePrompt/seed из триггера.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query } from '@/lib/database';
import { buildPollinationsUrl } from '@/lib/services/ingest/ai-image-generator';
import { aiNewsImagePrompt, travelNewsImagePrompt, hashStr } from '@/lib/notifications/post-image';
import { tgPostPhoto } from '@/lib/notifications/telegram-channel';

export const ManualChannelPostSchema = z.object({
  /** ai → TELEGRAM_AI_CHANNEL_ID, travel → TELEGRAM_CHANNEL_ID */
  channel: z.enum(['ai', 'travel']),
  /** HTML для Telegram (<b> <i> <a>). Лимит caption у sendPhoto — 1024. */
  text: z.string().min(50, 'Пост короче 50 символов — это не пост')
    .max(1024, 'Telegram обрезает caption после 1024 символов'),
  imagePrompt: z.string().min(10).max(500).optional(),
  seed: z.number().int().nonnegative().optional(),
});

export type ManualChannelPost = z.infer<typeof ManualChannelPostSchema>;

export function resolveChannelId(channel: ManualChannelPost['channel']): string | undefined {
  return channel === 'ai'
    ? process.env.TELEGRAM_AI_CHANNEL_ID
    : process.env.TELEGRAM_CHANNEL_ID;
}

export function manualPostTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Публикует пост. Идемпотентно по тексту: повторный запуск workflow с тем же
 * триггер-файлом (revert, rebase, ручной re-run) не задваивает пост в канале.
 */
export async function publishManualChannelPost(
  post: ManualChannelPost,
): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const channelId = resolveChannelId(post.channel);
  if (!channelId) {
    return { ok: false, error: `Канал ${post.channel} не настроен (env отсутствует)` };
  }

  const textHash = manualPostTextHash(post.text);
  try {
    const dup = await query(
      `SELECT 1 FROM ai_actions_log
        WHERE action_type = 'manual_channel_post'
          AND metadata->>'text_hash' = $1
          AND created_at > NOW() - INTERVAL '30 days'
        LIMIT 1`,
      [textHash],
    );
    if (dup.rows.length > 0) return { ok: true, duplicate: true };
  } catch { /* лог недоступен — публикуем без дедупа, это лучше молчания */ }

  const prompt = post.imagePrompt
    ?? (post.channel === 'ai' ? aiNewsImagePrompt(post.text) : travelNewsImagePrompt(post.text));
  const seed = post.seed ?? hashStr(post.text) % 9_999_999;
  const imageUrl = buildPollinationsUrl(prompt, seed, 1280, 720);

  const result = await tgPostPhoto(channelId, imageUrl, post.text);

  if (result.ok) {
    try {
      await query(
        `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
        ['manual_channel_post', JSON.stringify({
          channel: post.channel,
          text_hash: textHash,
          text_preview: post.text.slice(0, 200),
        })],
      );
    } catch { /* not critical */ }
  }

  return result;
}
