/**
 * Доставка экрана кабинета в чате в MAX (lib/chat-cabinet). Кнопка самого
 * экрана (`cb:`) правит то сообщение, под которым стоит — кабинет листается,
 * а не засыпает чат; кнопка строки меню, слово и команда — новое сообщение
 * (строка меню стоит и под уведомлениями, их править нельзя). MAX правит
 * только свои сообщения не старше суток: не принял — новым сообщением.
 *
 * Беда в тексте человека — блок 112 ОТДЕЛЬНЫМ сообщением перед экраном:
 * кнопки кабинета правят сообщение, под которым стоят, и блок над экраном
 * стёрла бы первая же из них (ревью 30.10).
 *
 * Экран с именем и телефоном клиента уходит в этот же личный диалог MAX, из
 * которого пришло нажатие; в Telegram такой экран не попадает (замок —
 * lib/chat-cabinet/service).
 */

import { withSosBlock } from '@/lib/safety/sos-detector';
import { maxCabinetRows } from '@/lib/chat-cabinet/render';
import type { CabinetScreen } from '@/lib/chat-cabinet/screens';

/** То, что нужно от клиента MAX: правка своего сообщения и новое сообщение. */
export interface MaxCabinetApi {
  editMessage(mid: string, extra: unknown): Promise<unknown>;
  sendMessageToChat(chatId: number, text: string, extra: unknown): Promise<unknown>;
}

function failure(what: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'отказ';
  console.error(`[chat-cabinet/max] ${what} — ${name}`);
}

export async function deliverCabinetMax(
  api: MaxCabinetApi,
  chatId: number,
  screen: CabinetScreen,
  editMid: string | null,
  userText?: string,
): Promise<void> {
  if (userText) {
    const sos = withSosBlock('', userText);
    if (sos.emergency) {
      try {
        await api.sendMessageToChat(chatId, sos.text.trim(), { format: 'html' });
      } catch (err) {
        failure('блок 112 в чат MAX', err);
      }
    }
  }
  const rows = maxCabinetRows(screen.rows);
  const attachments = rows.length ? [{ type: 'inline_keyboard', payload: { buttons: rows } }] : [];
  if (editMid) {
    try {
      const res = await api.editMessage(editMid, { text: screen.text, format: 'html', attachments }) as { success?: boolean } | null | undefined;
      if (res?.success !== false) return;
      console.error('[chat-cabinet/max] правка экрана кабинета не принята MAX — отправляю новым сообщением');
    } catch (err) {
      failure('правка экрана кабинета', err);
    }
  }
  try {
    await api.sendMessageToChat(chatId, screen.text, { format: 'html', attachments });
  } catch (err) {
    failure('экран кабинета в чат MAX', err);
  }
}
