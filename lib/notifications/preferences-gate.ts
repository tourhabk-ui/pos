/**
 * lib/notifications/preferences-gate.ts — спросить настройки перед отправкой.
 *
 * ПОВОД. 23.08.2026 настройки уведомлений перевели из Map в памяти в базу
 * (миграция 910): они перестали теряться при выкате. Но перепись показала, что
 * решать они по-прежнему не решали ничего — имена `unsubscribeAll`,
 * `quietHours`, `frequencyLimit` не встречались НИ В ОДНОМ пути отправки.
 * Человек снимал галочку, платформа честно её хранила и продолжала слать.
 * Прежде настройка терялась, теперь хранится и игнорируется; для получателя
 * разница невелика.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ.
 *
 * Безопасность не спрашивает настроек ВООБЩЕ. Ветка `safety` возвращает
 * решение ДО обращения к базе — не «сначала прочитаем, потом сделаем
 * исключение», а структурно: настройке нечего сказать про предупреждение о
 * лавине. Это то же правило, по которому SOS живёт единственной кнопкой
 * (CLAUDE.md §11): исключение, реализованное списком, однажды забудут
 * пополнить.
 *
 * Исходов ТРИ, не два (§4.0). «Не смогли прочитать настройки» — это не
 * «настроек нет» и не «слать нельзя». Что делать с третьим, решает
 * вызывающий: для брони и безопасности он шлёт, для рассылки — нет.
 *
 * Решение НАЗЫВАЕТ, чего оно не учло. `quietHours` и `frequencyLimit`
 * сохраняются эндпоинтом, но здесь НЕ вычисляются, и вот почему:
 *
 *   quietHours — это «с 22:00 до 08:00», а часового пояса получателя у
 *     платформы нет ни в одной таблице. Считать по Камчатке значит выдумать
 *     зону за туриста из Москвы и молча промахнуться на девять часов.
 *   frequencyLimit — «не чаще N в сутки» требует счётчика отправленного;
 *     такого учёта в репозитории нет.
 *
 * Обе честно перечислены в `unevaluated`, чтобы «учтено» и «не смотрели» не
 * выглядели одинаково. Появится зона и счётчик — появятся и правила.
 */

import { pool } from '@/lib/db-pool';

/**
 * Род сообщения. Определяет, что настройка вправе заглушить.
 * Обязателен на каждом вызове: умолчание молча зачислило бы новое
 * уведомление в самый безобидный род.
 */
export type NotificationKind =
  | 'safety'         // предупреждение, SOS, статус маршрута — настройкам неподвластно
  | 'transactional'  // бронь подтверждена/отменена, оплата — следствие действия человека
  | 'engagement'     // напоминания, подсказки, вовлечение
  | 'marketing';     // рассылка

export type GateVerdict = 'send' | 'suppress' | 'unknown';

export interface GateDecision {
  verdict: GateVerdict;
  /** Почему именно так — попадает в лог, а при подавлении отвечает на «почему не пришло». */
  reason: string;
  /** Что решение НЕ учитывало. Пусто — учтено всё, что настройка предлагает. */
  unevaluated: string[];
}

/** Настройки, которые эндпоинт /api/engagement/notifications/preferences хранит. */
interface StoredPreferences {
  channelPreferences?: Record<string, boolean>;
  typePreferences?: Record<string, boolean>;
  unsubscribeAll?: boolean;
  quietHours?: unknown;
  frequencyLimit?: unknown;
}

const NOT_EVALUATED = [
  'quietHours: часового пояса получателя у платформы нет',
  'frequencyLimit: учёта отправленного в репозитории нет',
];

/**
 * Можно ли слать это сообщение этому человеку.
 *
 * @param userId  получатель
 * @param kind    род сообщения — см. NotificationKind
 * @param channel 'push' | 'email' | 'sms' — сверяется с channelPreferences
 * @param type    тип уведомления (booking_confirmed и т.п.) — с typePreferences
 */
export async function checkNotificationAllowed(
  userId: string,
  kind: NotificationKind,
  channel?: string,
  type?: string,
): Promise<GateDecision> {
  // ДО базы. Настройке нечего сказать про безопасность, и порядок здесь —
  // часть правила: пока проверка стоит первой, её нельзя обойти отказом БД.
  if (kind === 'safety') {
    return { verdict: 'send', reason: 'род safety — настройки не спрашиваются', unevaluated: [] };
  }

  let stored: StoredPreferences | null;
  try {
    const result = await pool.query<{ prefs: StoredPreferences | null }>(
      `SELECT prefs FROM notification_preferences WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    stored = row?.prefs && typeof row.prefs === 'object' ? row.prefs : null;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[preferences-gate] настройки не прочитаны${code ? ` SQLSTATE ${code}` : ''} — ${message}`);
    return {
      verdict: 'unknown',
      reason: `настройки не прочитаны${code ? `: SQLSTATE ${code}` : ''}`,
      unevaluated: NOT_EVALUATED,
    };
  }

  if (!stored || Object.keys(stored).length === 0) {
    return { verdict: 'send', reason: 'человек настроек не менял', unevaluated: NOT_EVALUATED };
  }

  if (stored.unsubscribeAll === true) {
    return { verdict: 'suppress', reason: 'человек отписался от всего (unsubscribeAll)', unevaluated: NOT_EVALUATED };
  }

  if (channel && stored.channelPreferences?.[channel] === false) {
    return { verdict: 'suppress', reason: `канал ${channel} выключен получателем`, unevaluated: NOT_EVALUATED };
  }

  if (type && stored.typePreferences?.[type] === false) {
    return { verdict: 'suppress', reason: `тип ${type} выключен получателем`, unevaluated: NOT_EVALUATED };
  }

  return { verdict: 'send', reason: 'запретов в настройках нет', unevaluated: NOT_EVALUATED };
}
