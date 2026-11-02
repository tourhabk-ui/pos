import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const WD = readFileSync('lib/agents/watchdog.ts', 'utf8');
const body = () => { const i = WD.indexOf('async function checkFailedLeadDeliveries'); return WD.slice(i, WD.indexOf('\nasync function', i + 10)); };
describe('checkFailedLeadDeliveries', () => {
  it('стоит в CHECKS', () => { expect(WD.match(/const CHECKS[\s\S]*?\];/)![0]).toMatch(/\bcheckFailedLeadDeliveries\b/); });
  it('читает failed partner_notified, только SELECT, без действий', () => {
    const b = body();
    expect(b).toContain("action = 'partner_notified'");
    expect(b).toContain("'failed'");
    expect(b).not.toMatch(/INSERT|UPDATE|DELETE|notify|tgSend|ORDER BY/);
    expect(b).toContain("checkFailure('checkFailedLeadDeliveries'");
  });
  it('без ПД в тексте', () => { expect(body()).not.toMatch(/phone|email|name/i); });
});
