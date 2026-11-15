/**
 * Заявка внешнего агента: вызов агента — черновик и ссылка, отправка — сам
 * человек на /confirm (#3399, п. 4; lib/mcp/pending-request, pending-confirm).
 *
 * Тестам, которые судят исход записи, нужно «нажать» за человека: забрать
 * отложенную заявку по токену из ссылки и отправить её тем же путём, что
 * страница (runPublicTool с sentByHuman). Хранилище отложенных заявок в таких
 * тестах — в памяти (`memoryPendingModule`), чтобы не расписывать SQL.
 */
import { randomBytes } from 'node:crypto';

/** Токен из ссылки на /confirm в ответе агенту. */
export function confirmTokenOf(text: string): string {
  const m = /\/confirm#([A-Za-z0-9_-]{32})/.exec(text);
  if (!m) throw new Error(`В ответе нет ссылки на /confirm: ${text.slice(0, 300)}`);
  return m[1];
}

/** Черновик: заявка не создана, человеку — ссылка. */
export function isDraft(text: string): boolean {
  return /Черновик: заявка ещё НЕ создана/.test(text);
}

interface Row { tool: string; args: Record<string, unknown>; draftText: string; planRevision: string | null; via: 'mcp' | 'a2a'; sent: boolean }

/**
 * Замена lib/mcp/pending-request в памяти для vi.mock:
 *   vi.mock('@/lib/mcp/pending-request', async (orig) =>
 *     (await import('../helpers/mcp-two-step')).memoryPendingModule(await orig()));
 */
export function memoryPendingModule(original: Record<string, unknown>) {
  const rows = new Map<string, Row>();
  return {
    ...original,
    __rows: rows,
    createPendingRequest: async (p: { tool: string; args: Record<string, unknown>; draftText: string; planRevision: string | null; via: 'mcp' | 'a2a' }) => {
      const token = randomBytes(24).toString('base64url');
      rows.set(token, { ...p, args: { ...p.args }, sent: false });
      return token;
    },
    readPendingRequest: async (token: string) => {
      const r = rows.get(token);
      if (!r) return { kind: 'missing' as const };
      if (r.sent) return { kind: 'sent' as const };
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      return {
        kind: 'found' as const, tool: r.tool, draftText: r.draftText, name: str(r.args.name), phone: str(r.args.phone),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        parts: { tour: Boolean(r.args.tour), stay: Boolean(r.args.stay), transfer: Boolean(r.args.transfer_destination || r.args.stay_wanted), carrier: Boolean(r.args.carrier) },
      };
    },
    releasePendingRequest: async (token: string, args: Record<string, unknown>) => {
      const r = rows.get(token);
      if (!r || !r.sent) return false;
      r.sent = false;
      r.args = { ...args };
      return true;
    },
    claimPendingRequest: async (token: string) => {
      const r = rows.get(token);
      if (!r || r.sent) return { kind: 'gone' as const };
      const args = r.args;
      r.sent = true;
      r.args = {};
      return { kind: 'claimed' as const, tool: r.tool, args, planRevision: r.planRevision, via: r.via };
    },
  };
}

/**
 * «Нажать „Отправить“» за человека — тем же путём, что страница, но вернуть
 * сырой исход исполнителя (тесты судят его, а не слова страницы).
 */
export async function sendAsHuman(text: string, ip = '10.200.0.1') {
  const { claimPendingRequest } = await import('@/lib/mcp/pending-request');
  const { runPublicTool } = await import('@/app/api/mcp/route');
  const c = await claimPendingRequest(confirmTokenOf(text));
  if (c.kind !== 'claimed') throw new Error(`Отложенная заявка не забрана: ${c.kind}`);
  return runPublicTool({
    toolName: c.tool, rawArguments: { ...c.args, consent: true }, ip, userAgent: 'test-confirm-page', self: false,
    sentByHuman: { ip }, ...(c.via === 'a2a' ? { via: 'a2a' as const } : {}),
  });
}
