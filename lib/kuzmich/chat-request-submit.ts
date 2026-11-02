/**
 * Отправка заявки из чата Кузьмича (веб, MAX) одним исполнителем — тем же
 * runPublicTool, что у MCP: стражи записи, живая проверка мест по базе,
 * согласие и уведомление оператора считаются там один раз. Импорт роута
 * ленивый: роут MCP сам импортирует lib/kuzmich/core.
 */
import { humanChatConfirm, chatRequestNotCreated, type ChatRequestPlan } from '@/lib/kuzmich/chat-request';

export async function submitChatRequest(
  plan: ChatRequestPlan,
  opts: { ip: string; userAgent: string; tourTitle?: string | null },
): Promise<{ ok: boolean; text: string }> {
  try {
    const { runPublicTool } = await import('@/app/api/mcp/route');
    const out = await runPublicTool({ toolName: plan.tool, rawArguments: plan.args, ip: opts.ip, userAgent: opts.userAgent, self: false });
    if (out.kind === 'ok') return { ok: true, text: humanChatConfirm(out.text, opts.tourTitle) };
    if (out.kind === 'refused' || out.kind === 'rate_limited') return { ok: false, text: chatRequestNotCreated(out.text) };
    return { ok: false, text: chatRequestNotCreated(null) };
  } catch (e) {
    console.warn('[kuzmich-chat] заявка не создана', e instanceof Error ? e.message.slice(0, 200) : '');
    return { ok: false, text: chatRequestNotCreated(null) };
  }
}
