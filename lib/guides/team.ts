/**
 * Кабинет гида и команда оператора — общие мелочи роутов (миграции 1018/1019).
 *
 * SQL — в `lib/guides/team-queries.ts`; здесь только то, что вокруг него:
 * след отказа в логе и уведомление, которое не роняет основное действие.
 */
import { query } from '@/lib/database';
import { TEAM_SQL } from '@/lib/guides/team-queries';

/**
 * §4.0: ловить можно, молчать нельзя. Имя проверки и SQLSTATE — в лог; наружу
 * человеку уходит русское «не удалось», а не «пусто».
 */
export function logGuideFailure(check: string, error: unknown): void {
  const e = error as { code?: string; message?: string } | null;
  console.error(`[guides] ${check}: отказ`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(error));
}

/** Статусы приглашения — ровно те, что держит CHECK миграции 1018. */
export const INVITE_STATUSES = ['pending', 'accepted', 'declined', 'revoked', 'left'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  pending: 'Ждёт ответа',
  accepted: 'Принято',
  declined: 'Отклонено',
  revoked: 'Отозвано',
  left: 'Гид вышел',
};

/**
 * Внутреннее уведомление в кабинет. Без ПД туриста — только тур, дата и
 * оператор: уведомление видно в списке, где не проверяется назначение.
 * Отказ записи не отменяет действие (приглашение/назначение уже сделано),
 * но пишется в лог — «не уведомили» не должно выглядеть как «уведомили».
 */
export async function notifyUser(params: {
  userId: string | null | undefined;
  type: 'guide_invite' | 'guide_assignment';
  title: string;
  message: string;
  data: Record<string, unknown>;
  actionUrl: string;
}): Promise<void> {
  if (!params.userId) return;
  try {
    await query(TEAM_SQL.notify, [
      params.userId,
      params.type,
      params.title,
      params.message,
      JSON.stringify(params.data),
      params.actionUrl,
    ]);
  } catch (error) {
    logGuideFailure(`notify.${params.type}`, error);
  }
}

/** Формат id: бронь — bigint, приглашение/запись/партнёр — uuid. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BIGINT_RE = /^\d{1,18}$/;
