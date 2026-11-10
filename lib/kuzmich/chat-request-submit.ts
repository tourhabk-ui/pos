/**
 * Отправка заявки из чата Кузьмича (веб, MAX) одним исполнителем — тем же
 * runPublicTool, что у MCP: стражи записи, живая проверка мест по базе,
 * согласие и уведомление оператора считаются там один раз. Импорт роута
 * ленивый: роут MCP сам импортирует lib/kuzmich/core.
 */
import { chatToolReply, chatRequestUnconfirmed, type ChatRequestPlan } from '@/lib/kuzmich/chat-request';
import { journaledWrite, WriteInFlightError, type WriteChannel } from '@/lib/kuzmich/write-journal';
import { issuedKeysOf, linkChannelOf, linkChatToKeys } from '@/lib/requests/chat-links';

export async function submitChatRequest(
  plan: ChatRequestPlan,
  opts: { ip: string; userAgent: string; tourTitle?: string | null; channel?: WriteChannel; sessionRef?: string },
): Promise<{ ok: boolean; text: string }> {
  try {
    const { runPublicTool } = await import('@/app/api/mcp/route');
    const channel: WriteChannel = opts.channel ?? (opts.ip.startsWith('max:') ? 'max' : opts.ip.startsWith('tg:') ? 'tg' : 'web');
    const sessionRef = opts.sessionRef ?? opts.ip.slice(0, 120);
    // Согласие дал человек в чате, а не агент (06.11): канал — чат, адрес у
    // мессенджера неизвестен — id чата в поле адреса не пишется.
    const consentFrom = { source: `kuzmich-${channel}` as const, ip: channel === 'web' ? opts.ip : null };
    const out = await journaledWrite({ channel, sessionRef, tool: plan.tool, args: plan.args },
      () => runPublicTool({ toolName: plan.tool, rawArguments: plan.args, ip: opts.ip, userAgent: opts.userAgent, self: false, consentFrom }));
    // ok — только если заявка правда записана: отказ текстом («мест нет —
    // заявка не создана») тоже приходит kind: 'ok' (#2967).
    const reply = chatToolReply(out, opts.tourTitle);
    // Заявка из чата мессенджера — в «Мою поездку» этого чата (#2970, 1416):
    // ключи, выданные этим вызовом. Повтор из журнала ключей не несёт —
    // связь осталась от первого вызова. Веб связи не даёт.
    const linkCh = linkChannelOf(channel);
    if (reply.created && linkCh) {
      const chatId = opts.ip.slice(opts.ip.indexOf(':') + 1);
      const structured = (out as { structured?: unknown } | null)?.structured;
      await linkChatToKeys(linkCh, chatId, issuedKeysOf(structured), 'created');
    }
    return { ok: reply.created, text: reply.text };
  } catch (e) {
    if (e instanceof WriteInFlightError) return { ok: false, text: chatRequestUnconfirmed() };
    // Исключение могло прийти и после записи (обрыв ответа): «не записалась»
    // было бы неправдой — честно «не могу подтвердить» (разбор 03.11, п.8).
    console.warn('[kuzmich-chat] исход заявки неизвестен', e instanceof Error ? e.message.slice(0, 200) : '');
    return { ok: false, text: chatRequestUnconfirmed() };
  }
}
