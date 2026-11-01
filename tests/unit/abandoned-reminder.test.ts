import { describe, it, expect } from 'vitest';
import { reminderDue, buildReminder, type AbandonedDraft } from '@/lib/requests/abandoned-reminder';
import { RECONTACT_CONSENT_VERSION, RECONTACT_CONSENT_TEXT } from '@/lib/legal/recontact-consent';
import { PD_CONSENT_TEXT } from '@/lib/legal/pd-consent';

const now = new Date('2026-11-02T12:00:00Z');
const d = (p: Partial<AbandonedDraft> = {}): AbandonedDraft => ({
  createdAt: new Date(now.getTime() - 2 * 3600_000), submittedAt: null, remindersSent: 0,
  recontactConsentVersion: RECONTACT_CONSENT_VERSION, recontactWithdrawn: false, channel: 'max',
  resumeToken: 'tok123', title: 'Вулкан Мутновский', ...p,
});

describe('abandoned reminder', () => {
  it('отдельное согласие, не то же, что передача оператору', () => {
    expect(RECONTACT_CONSENT_TEXT.ru).not.toBe(PD_CONSENT_TEXT);
    expect(RECONTACT_CONSENT_TEXT.ru).toMatch(/один раз/);
  });
  it('только одно напоминание и только с согласием', () => {
    expect(reminderDue(d(), now)).toBe(true);
    expect(reminderDue(d({ remindersSent: 1 }), now)).toBe(false);
    expect(reminderDue(d({ recontactConsentVersion: null }), now)).toBe(false);
    expect(reminderDue(d({ recontactWithdrawn: true }), now)).toBe(false);
    expect(reminderDue(d({ submittedAt: now }), now)).toBe(false);
    expect(reminderDue(d({ createdAt: new Date(now.getTime() - 60_000) }), now)).toBe(false);
    expect(reminderDue(d({ createdAt: new Date(now.getTime() - 100 * 3600_000) }), now)).toBe(false);
  });
  it('Telegram без ПД и без названия; кнопка «Отправить заявку»', () => {
    const r = buildReminder(d({ channel: 'telegram' }), 'https://vedarai.ru');
    expect(r.text).not.toMatch(/Мутновский|\+7|\d{10}/);
    expect(r.button).toEqual({ label: 'Отправить заявку', url: 'https://vedarai.ru/request-resume#tok123' });
    expect(r.text).not.toMatch(/мгновенн|временно/i);
  });
  it('MAX может назвать тур', () => {
    expect(buildReminder(d(), 'https://vedarai.ru').text).toMatch('Мутновский');
  });
});
