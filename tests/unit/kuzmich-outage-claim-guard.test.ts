import { describe, it, expect } from 'vitest';
import { guardOutageClaims, OUTAGE_HONEST_LINE } from '@/lib/kuzmich/outage-claim-guard';
import { requestConfirmNote } from '@/lib/mcp/request-confirm-note';

describe('outage-claim-guard (снимок CTO 31.10)', () => {
  it('заменяет выдуманный сбой базы честной строкой', () => {
    const r = guardOutageClaims('Андрей, спасибо! Поскольку прямой доступ к базе сервиса временно ограничен, заявки передаются специалисту в ручном режиме. Менеджер свяжется с вами.');
    expect(r.text).not.toMatch(/ограничен|ручном режиме/);
    expect(r.text).toContain(OUTAGE_HONEST_LINE);
    expect(r.text).toContain('Андрей, спасибо!');
    expect(r.removed).toHaveLength(1);
  });
  it('английская формулировка тоже', () => {
    const r = guardOutageClaims('The database is temporarily unavailable, so your request will be handled manually.');
    expect(r.text).toBe(OUTAGE_HONEST_LINE);
  });
  it('обычный ответ не трогает', () => {
    const a = 'Заявка создана. Оператор свяжется с вами для подтверждения.';
    expect(guardOutageClaims(a)).toEqual({ text: a, removed: [] });
  });
});

describe('requestConfirmNote', () => {
  it('RU/EN/ZH и запрет на «сбой»', () => {
    const n = requestConfirmNote(false);
    expect(n).toContain('Заявка создана. Оператор свяжется с вами для подтверждения. Мгновенного бронирования нет — подтверждает человек, оплаты через платформу нет.');
    expect(n).toContain('Request created.');
    expect(n).toContain('申请已创建');
    expect(n).toContain('не сбой');
  });
  it('при включённой оплате не обещает «оплаты нет»', () => {
    expect(requestConfirmNote(true)).not.toContain('оплаты через платформу нет');
  });
});
