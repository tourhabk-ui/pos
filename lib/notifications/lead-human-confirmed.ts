/**
 * Менеджеру — человек подтвердил заявку, которую оставил ИИ-агент через MCP
 * (05.11, владелец: «мы пока не различаем лиды людей от mcp»).
 *
 * Лид агента приходит с пометкой «человек не подтвердил»: согласие на данные
 * за человека заявил агент. Человек подтверждает его галочкой на странице
 * заявки (`confirmConsent`, источник `request-page`), и до этого дня об этом
 * не узнавал никто — пометка в рабочем чате так и оставалась.
 *
 * ПД здесь нет: номер заявки и ссылка в CRM. Поэтому текст и заглушка для
 * Telegram одинаковы; адресат — тот же рабочий чат, куда пришёл сам лид.
 * Согласие уже записано, и отказ доставки его не отменяет: исход — в лог.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { sendPdAlert } from '@/lib/notifications/pd-alert';

// Отметка на странице — не доказательство человека (ревью безопасности
// #3252): страница открывается ключом заявки, а ключ выдан агенту, и нажать
// может он сам. Поэтому текст называет факт — «отмечено на странице», — а не
// «человек подтвердил» и не «это заявка человека».
export function leadHumanConfirmedText(leadId: string): string {
  return [
    '<b>Согласие отмечено на странице заявки</b>',
    `Заявка <code>${leadId.replace(/[^0-9a-f-]/gi, '')}</code> от ИИ-агента через MCP: согласие на передачу данных отмечено на странице заявки. Ссылка на неё есть и у агента — кто нажал, человек или агент, платформа не проверяет; человека подтвердит звонок.`,
  ].join('\n');
}

export async function notifyLeadHumanConfirmedQuietly(leadId: string): Promise<void> {
  try {
    const text = leadHumanConfirmedText(leadId);
    const res = await sendPdAlert({
      text,
      stub: text,
      buttons: [{ text: 'Открыть в CRM', url: `${getPublicBaseUrl()}/hub/operator/leads/${encodeURIComponent(leadId)}` }],
    });
    if (!res.delivered && res.channel !== 'telegram-stub') {
      console.error(`[lead-human-confirmed] о подтверждении заявки ${leadId} не сообщено (${res.channel}) — ${res.reason}`);
    }
  } catch (err) {
    console.error('[lead-human-confirmed] отправка упала:', err instanceof Error ? err.message : err);
  }
}
