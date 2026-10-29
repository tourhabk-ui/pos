/**
 * Кнопки экрана кабинета в чате → клавиатура MAX и Telegram. Без сети:
 * доставку (правка сообщения с кнопкой или новое) делает вебхук.
 *
 * Кнопка «Скопировать» (`copy`) — только MAX (`clipboard`). В Telegram она
 * не рисуется: там на экранах кабинета нет телефона, и кнопке нечего
 * копировать (если она всё же пришла — правка экранов не тот замок, и её
 * текст в Telegram не уходит).
 */

import type { CabinetButton } from '@/lib/chat-cabinet/screens';

export type MaxCabinetButton =
  | { type: 'callback'; text: string; payload: string; intent?: 'positive' | 'negative' }
  | { type: 'link'; text: string; url: string }
  | { type: 'clipboard'; text: string; payload: string };

export function maxCabinetRows(rows: readonly CabinetButton[][]): MaxCabinetButton[][] {
  return rows
    .map((row) => row.map((b): MaxCabinetButton => {
      if ('url' in b) return { type: 'link', text: b.text, url: b.url };
      if ('copy' in b) return { type: 'clipboard', text: b.text, payload: b.copy };
      return b.intent
        ? { type: 'callback', text: b.text, payload: b.payload, intent: b.intent }
        : { type: 'callback', text: b.text, payload: b.payload };
    }))
    .filter((row) => row.length > 0);
}

export type TelegramCabinetButton = { text: string; callback_data: string } | { text: string; url: string };

export function telegramCabinetKeyboard(rows: readonly CabinetButton[][]): { inline_keyboard: TelegramCabinetButton[][] } {
  return {
    inline_keyboard: rows
      .map((row) => row.flatMap((b): TelegramCabinetButton[] => {
        if ('copy' in b) return [];
        if ('url' in b) return [{ text: b.text, url: b.url }];
        return [{ text: b.text, callback_data: b.payload }];
      }))
      .filter((row) => row.length > 0),
  };
}
