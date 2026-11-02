// @vitest-environment node
/**
 * /llms.txt называет агенту три правила заявки прямо (#2968, 03.11):
 * заявка — не бронь; согласие на ПД даёт сам человек; Ведар не продавец.
 * И как понять исход: поле `created` ответа `POST /api/hub/bookings/create`.
 * Судит вызов роута /llms.txt (база подложена пустой).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { GET } from '@/app/llms.txt/route';
import { agentRequestRulesRu, agentRequestRulesEn } from '@/lib/mcp/agent-request-rules';
import { paymentRule } from '@/lib/mcp/payment-rule';

describe('/llms.txt: три правила заявки для агента', () => {
  it('правила по-русски стоят в разделе «Как ИИ-агенту оставить заявку без MCP», английские — в сводке', async () => {
    const text = await (await GET()).text();
    const section = text.split('## Как ИИ-агенту оставить заявку без MCP')[1]?.split('\n## ')[0] ?? '';
    expect(section).toContain(agentRequestRulesRu(false));
    expect(text).toContain(agentRequestRulesEn(false));
  });
  it.each([false, true])('слова правил при выключателе оплаты %s', (accepts) => {
    const ru = agentRequestRulesRu(accepts);
    expect(ru).toMatch(/Заявка — не бронь/);
    expect(ru).toMatch(/Согласие на обработку персональных данных даёт сам человек/);
    expect(ru).toMatch(/Агент не ставит его за человека/);
    expect(ru).toMatch(/Ведар не продавец/);
    expect(ru).toContain(paymentRule(accepts));
    expect(ru).toMatch(/`created`.*`true`.*`false` — \*\*заявка не создана\*\*/s);
    const en = agentRequestRulesEn(accepts);
    expect(en).toMatch(/not a booking/);
    expect(en).toMatch(/never by the agent/);
    expect(en).toMatch(/Vedar is not the seller/);
    expect(en).toMatch(/created: true/);
  });
});
