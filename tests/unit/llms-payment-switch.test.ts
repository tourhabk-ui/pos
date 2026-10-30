// @vitest-environment node
/**
 * Файлы для агентов говорят об оплате по выключателю (30.10).
 *
 * До этого /llms.txt («мгновенной брони и оплаты через портал нет», «there is
 * no payment through the platform»), /llms-en.txt и /llms-zh.txt говорили
 * «оплаты нет» безусловно, а инструкция сервера MCP — по выключателю
 * PLATFORM_ACCEPTS_PAYMENTS. Включи владелец оплату — агент прочитал бы в
 * рукопожатии одно, а в llms.txt другое. Теперь слова — одни
 * (lib/mcp/payment-rule), и машина под заказ, прокат и жильё не оплачиваются
 * через платформу при любом положении.
 *
 * Судит вызов: роут /llms.txt при подложенном выключателе в обоих положениях,
 * файлы llms-en/llms-zh — с выключателем параметром.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sw = vi.hoisted(() => ({ accepts: false }));
vi.mock('@/lib/payments/accepting', () => ({
  PLATFORM_ACCEPTS_PAYMENTS: false,
  platformAcceptsPayments: () => sw.accepts,
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { GET } from '@/app/llms.txt/route';
import { llmsEnFile } from '@/lib/mcp/en-layer';
import { llmsZhFile } from '@/lib/mcp/zh-layer';
import { paymentRule, paymentRuleEn, paymentRuleZh } from '@/lib/mcp/payment-rule';
import { buildServerInstructions } from '@/lib/mcp/server-instructions';

const BASE = 'https://vedarai.ru';
const llmsTxt = async () => (await GET()).text();

// Безусловное «оплаты нет» — на трёх языках, в тех формах, что стояли до 30.10.
const UNCONDITIONAL = [/оплаты через портал нет/, /no payment through the (?:platform|portal)/i, /No online payment/, /无在线支付/, /款项直接付给旅行社/];

describe('правило оплаты по выключателю — одно на рукопожатие MCP и llms-файлы', () => {
  beforeEach(() => { sw.accepts = false; });

  it.each([false, true])('/llms.txt при выключателе %s: правило по-русски и по-английски, то же, что в инструкции сервера', async (accepts) => {
    sw.accepts = accepts;
    const text = await llmsTxt();
    expect(text).toContain(paymentRule(accepts));
    expect(text).toContain(paymentRuleEn(accepts));
    expect(text).toContain(paymentRuleZh(accepts));
    // Та же фраза, что правило 8 рукопожатия MCP.
    expect(buildServerInstructions({ acceptsPayments: accepts })).toContain(paymentRule(accepts));
    // Правило другого положения не просочилось.
    expect(text).not.toContain(paymentRule(!accepts));
    expect(text).not.toContain(paymentRuleEn(!accepts));
    for (const re of UNCONDITIONAL) expect(text, String(re)).not.toMatch(re);
  });

  it('выключено: «не принимает, напрямую»; включено — «после подтверждения оператором»', async () => {
    sw.accepts = false;
    const off = await llmsTxt();
    expect(off).toMatch(/Ведар сейчас оплату не принимает: тур оплачивают исполнителю напрямую/);
    expect(off).toMatch(/Vedar does not accept payments right now/);
    sw.accepts = true;
    const on = await llmsTxt();
    expect(on).toMatch(/Оплата тура — только после подтверждения оператором/);
    expect(on).not.toMatch(/оплату не принимает/);
    // Машина, прокат, жильё — не через платформу в обоих положениях.
    for (const t of [off, on]) {
      expect(t).toMatch(/машина под заказ, прокат и жильё через платформу не оплачиваются/);
      expect(t).toMatch(/vehicle charters, self-drive car rental and accommodation are not paid through the platform/);
    }
  });

  it.each([false, true])('/llms-en.txt и /llms-zh.txt при выключателе %s', (accepts) => {
    const en = llmsEnFile(BASE, accepts);
    const zh = llmsZhFile(BASE, accepts);
    expect(en).toContain(paymentRuleEn(accepts));
    expect(en).not.toContain(paymentRuleEn(!accepts));
    expect(zh).toContain(paymentRuleZh(accepts));
    expect(zh).not.toContain(paymentRuleZh(!accepts));
    for (const re of UNCONDITIONAL) {
      expect(en, String(re)).not.toMatch(re);
      expect(zh, String(re)).not.toMatch(re);
    }
    // Остальное в файле на месте: пять заявок и человек, который их подтверждает.
    expect(en).toMatch(/human-confirmed requests/);
    expect(zh).toMatch(/均由人工确认/);
  });

  it('без параметра файлы берут положение выключателя', () => {
    sw.accepts = true;
    expect(llmsEnFile(BASE)).toContain(paymentRuleEn(true));
    expect(llmsZhFile(BASE)).toContain(paymentRuleZh(true));
    sw.accepts = false;
    expect(llmsEnFile(BASE)).toContain(paymentRuleEn(false));
    expect(llmsZhFile(BASE)).toContain(paymentRuleZh(false));
  });
});
