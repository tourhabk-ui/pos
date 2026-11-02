/**
 * Отправка заявки из чата Кузьмича (веб, MAX) одним исполнителем — тем же
 * runPublicTool, что у MCP: стражи записи, живая проверка мест по базе,
 * согласие и уведомление оператора считаются там один раз. Импорт роута
 * ленивый: роут MCP сам импортирует lib/kuzmich/core.
 */
import { chatToolReply, chatRequestNotCreated, chatRequestUnconfirmed, type ChatRequestPlan } from '@/lib/kuzmich/chat-request';
import { journaledWrite, WriteInFlightError, type WriteChannel } from '@/lib/kuzmich/write-journal';

export async function submitChatRequest(
  plan: ChatRequestPlan,
  opts: { ip: string; userAgent: string; tourTitle?: string | null; channel?: WriteChannel; sessionRef?: string },
): Promise<{ ok: boolean; text: string }> {
  try {
    const { runPublicTool } = await import('@/app/api/mcp/route');
    const channel: WriteChannel = opts.channel ?? (opts.ip.startsWith('max:') ? 'max' : opts.ip.startsWith('tg:') ? 'tg' : 'web');
    const sessionRef = opts.sessionRef ?? opts.ip.slice(0, 120);
    const out = await journaledWrite({ channel, sessionRef, tool: plan.tool, args: plan.args },
      () => runPublicTool({ toolName: plan.tool, rawArguments: plan.args, ip: opts.ip, userAgent: opts.userAgent, self: false }));
    // ok — только если заявка правда записана: отказ текстом («мест нет —
    // заявка не создана») тоже приходит kind: 'ok' (#2967).
    const reply = chatToolReply(out, opts.tourTitle);
    return { ok: reply.created, text: reply.text };
  } catch (e) {
    if (e instanceof WriteInFlightError) return { ok: false, text: chatRequestUnconfirmed() };
    console.warn('[kuzmich-chat] заявка не создана', e instanceof Error ? e.message.slice(0, 200) : '');
    return { ok: false, text: chatRequestNotCreated(null) };
  }
}
