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

describe('recontact consent — утверждённый текст и ссылка на политику', () => {
  it('версия утверждённая, ссылка на политику та же, что у основного согласия, на трёх языках', async () => {
    const m = await import('@/lib/legal/recontact-consent');
    const pd = await import('@/lib/legal/pd-consent');
    expect(m.RECONTACT_CONSENT_VERSION).not.toMatch(/draft/);
    expect(m.RECONTACT_POLICY_URL).toBe(pd.PD_CONSENT_POLICY_URL);
    for (const l of ['ru', 'en', 'zh'] as const) {
      expect(m.RECONTACT_CONSENT_TEXT[l].length).toBeGreaterThan(40);
      expect(m.RECONTACT_POLICY_LINK[l].link.length).toBeGreaterThan(1);
    }
  });
  it('ключ ссылки напоминания открыт публично только на POST /api/request-drafts/resume', async () => {
    const { PUBLIC_API_ROUTES } = await import('@/lib/auth/public-api-routes');
    expect(PUBLIC_API_ROUTES['/api/request-drafts/resume']).toEqual(['POST']);
    expect(PUBLIC_API_ROUTES['/api/request-drafts']).toBeUndefined();
  });
});
