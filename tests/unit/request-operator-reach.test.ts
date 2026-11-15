/**
 * Итог заявки на тур — по тому, дойдёт ли она до оператора (разбор промпта
 * Кузьмича 15.11, п. 3).
 *
 * До этого и инструмент MCP, и чат Кузьмича всегда говорили «Оператор
 * свяжется с вами»: уведомление оператору уходит фоном, и ответ его исхода не
 * знал. У оператора без MAX и Telegram заявка до него не доходила, а человек
 * ждал звонка. Теперь инструмент читает адреса оператора до ответа и называет
 * исход: есть мессенджер — «оператор свяжется», нет — «передаст команда
 * Ведара», не прочиталось — так и сказано. Исход зависит только от тура, не
 * от телефона: ответ повтора тот же (анти-оракул).
 *
 * Роут MCP исполняется целиком (как mcp-booking-park-note), подменены база,
 * туры, занятость и адреса оператора. Чат и поездка целиком — вызовом.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reachMock = vi.hoisted(() => vi.fn());
const slotsMock = vi.hoisted(() => vi.fn());
const TOUR = { id: '7', title: 'Мутновский (тест)', operator_id: 'op-1' };

vi.mock('@/lib/leads/create', () => ({
  createLead: async () => 'lead-1',
  createLeadDetailed: async () => ({ id: 'lead-1', created: true }),
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/tool-schemas', () => ({ TOOL_REGISTRY: {}, validateToolArgs: () => ({ ok: true, args: {} }) }));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/kuzmich/tour-availability-tool', () => ({
  resolveTourChoice: async () => ({ kind: 'one', tour: TOUR }),
  candidateLines: () => [], choiceListLines: () => [], choiceListReason: () => '',
}));
vi.mock('@/lib/planner', () => ({ createPlannerCache: () => ({}), fetchAvailabilityForTour: (...a: unknown[]) => slotsMock(...a) }));
vi.mock('@/lib/seat-requests/service', () => ({ createSeatRequest: vi.fn(), tourKeepsSchedule: vi.fn(), statusUrl: (t: string) => t }));
vi.mock('@/lib/planner/park-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner/park-status')>()),
  loadPlanParkAlerts: async () => [],
}));
vi.mock('@/lib/partners/reach', async (orig) => ({
  ...(await orig<typeof import('@/lib/partners/reach')>()),
  reachForPartner: (...a: unknown[]) => reachMock(...a),
}));
vi.mock('@/lib/notifications/lead-notify', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifications/lead-notify')>()),
  notifyPartnerNewLeadPersonally: async () => ({ state: 'no_channel' }),
}));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: async () => true }));
vi.mock('@/lib/db-pool', () => {
  const q = async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ a: '0', b: '0', c: '0' }] } : { rows: [] });
  return { pool: { query: q, connect: async () => ({ query: q, release: () => {} }) } };
});

// Отложенные заявки агента — в памяти: отправку «нажимает» тест за человека.
vi.mock('@/lib/mcp/pending-request', async (orig) => (await import('../helpers/mcp-two-step')).memoryPendingModule(await orig()));

import { POST } from '@/app/api/mcp/route';
import { humanChatConfirm } from '@/lib/kuzmich/chat-request';
import { runTripRequest } from '@/lib/agent/trip-request';
import { requestConfirmNote, OPERATOR_NO_CHANNEL_MARK } from '@/lib/mcp/request-confirm-note';
import { isDraft, sendAsHuman } from '../helpers/mcp-two-step';

const DATE = new Date(Date.now() + 12 * 3_600_000 + 5 * 86_400_000).toISOString().slice(0, 10);
const args = { tour: 'Мутновский', date: DATE, participants: 2, name: 'Тест', phone: '+79001234567', consent: true };
function call(a: Record<string, unknown>) {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.2.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_booking_request', arguments: a } }),
  }) as unknown as Parameters<typeof POST>[0];
}
const textOf = async (a: Record<string, unknown>) => {
  const j = await (await POST(call(a))).json();
  return String(j.result?.content?.[0]?.text ?? j.error?.message ?? '');
};
/**
 * Заявку внешнего агента отправляет человек на /confirm (lib/mcp/pending-request):
 * вызов агента — черновик со ссылкой, запись — нажатие человека; итог
 * передачи — в исходе его отправки.
 */
let pageIp = 0;
const toolText = async () => {
  const draft = await textOf(args);
  expect(isDraft(draft), draft).toBe(true);
  pageIp += 1;
  const out = await sendAsHuman(draft, `10.0.4.${pageIp}`);
  expect(out.kind).toBe('ok');
  return out.kind === 'ok' ? out.text : '';
};
const RU = (t: string) => /RU: ([^]*?) EN:/.exec(t)?.[1] ?? '';

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  reachMock.mockReset();
  slotsMock.mockReset();
  slotsMock.mockResolvedValue([{ date: DATE, remaining: 5 }]);
});

describe('create_booking_request: исход передачи оператору', () => {
  it('у оператора есть мессенджер — «оператор свяжется», без строки о команде', async () => {
    reachMock.mockResolvedValue({ telegramChatId: null, maxChatId: '123', telegramSource: null });
    const t = await toolText();
    expect(reachMock).toHaveBeenCalledWith('op-1');
    expect(RU(t)).toContain('Оператор свяжется с вами для подтверждения.');
    expect(t).not.toContain(OPERATOR_NO_CHANNEL_MARK);
    expect(humanChatConfirm(t)).toContain('Оператор свяжется с вами по указанному телефону');
  });

  it('мессенджера нет — «передаст команда Ведара», звонок от оператора не обещан', async () => {
    reachMock.mockResolvedValue({ telegramChatId: null, maxChatId: null, telegramSource: null });
    const t = await toolText();
    expect(t).toContain(`${OPERATOR_NO_CHANNEL_MARK}: заявку ему передаст команда Ведара`);
    expect(RU(t)).not.toContain('Оператор свяжется с вами для подтверждения.');
    const human = humanChatConfirm(t);
    expect(human).toContain('заявку ему передаст команда Ведара');
    expect(human).not.toContain('Оператор свяжется с вами по указанному телефону');
    expect(human).toContain('the Vedar team will pass it to the operator');
  });

  it('адреса не прочитались — так и сказано, а не «оператор свяжется»', async () => {
    reachMock.mockResolvedValue(null);
    const t = await toolText();
    expect(t).toContain('Дошла ли заявка до оператора, проверить не удалось');
    expect(humanChatConfirm(t)).not.toContain('Оператор свяжется с вами по указанному телефону');
  });
});

describe('поездка целиком: строка о передаче остаётся у части, итог не обещает лишнего', () => {
  it('тур без мессенджера оператора — последняя фраза сводки не «оператор свяжется»', async () => {
    const legText = `Заявка оператору принята: "Мутновский", ${DATE}. ${OPERATOR_NO_CHANNEL_MARK}: заявку ему передаст команда Ведара, после этого он свяжется с вами.${requestConfirmNote(undefined, 'none')}`;
    const r = await runTripRequest(
      { tour: '7', date: DATE, participants: 2, name: 'Тест', phone: '+79001234567', consent: true },
      {
        bookTour: async () => legText,
        requestStay: async () => '',
        requestCharter: async () => '',
        createLead: async () => '',
        confirmNote: requestConfirmNote(),
        confirmNoteFor: (reach) => requestConfirmNote(undefined, reach),
      } as Parameters<typeof runTripRequest>[1],
    );
    expect(r.text).toContain(OPERATOR_NO_CHANNEL_MARK);
    // Фраза части вырезана, в конце одна — и без обещания оператора.
    expect(r.text.match(/Скажи человеку его языком/g)).toHaveLength(1);
    expect(RU(r.text)).not.toContain('Оператор свяжется с вами для подтверждения.');
  });
});
