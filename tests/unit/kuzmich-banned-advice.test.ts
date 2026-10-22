import { describe, it, expect } from 'vitest';
import { stripBannedAdvice, BANNED_ADVICE_NOTE } from '@/lib/kuzmich/banned-advice';
import { guardSafetyClaims } from '@/lib/kuzmich/safety-claim-guard';

describe('stripBannedAdvice', () => {
  it('вырезает «притворись мёртвым» и ставит 112', () => {
    const r = stripBannedAdvice('Не беги. Если атакует — падай на живот и притворись мёртвым. Ходи группой.');
    expect(r.text).not.toMatch(/притвор/i);
    expect(r.text).toContain('Не беги.');
    expect(r.text).toContain('Ходи группой.');
    expect(r.text).toContain(BANNED_ADVICE_NOTE);
    expect(r.removed).toHaveLength(1);
  });
  it('отрицание не трогает', () => {
    const a = 'Не притворяйся мёртвым, медленно отходи.';
    expect(stripBannedAdvice(a).text).toBe(a);
  });
  it('сторож утверждений применяет запрет', () => {
    expect(guardSafetyClaims('Притворитесь мёртвыми.', null).text).not.toMatch(/притвор/i);
  });
});
