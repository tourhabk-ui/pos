import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLBACK_MAX_BYTES, LEGACY_UNSIGNED_UNTIL_MS, WRITE_BUTTON_TTL_MS, isWritePayload, signPayload, unwrapPress,
} from '@/lib/chat-cabinet/signed-payload';
import { cabinetPayload } from '@/lib/chat-cabinet/payload';
import { chatAnswerButtons } from '@/lib/requests/chat-answer-buttons';
import { answerPressPayload } from '@/lib/bookings/chat-owner-press';
import { odOpen } from '@/lib/operators/chat-dates/flow';
import { adminAnswerPayload, adminLeadPayload, adminOpenLeadPayload, adminTourPayload } from '@/lib/max/admin-actions';

const UUID = '0f13cf25-e5a5-461f-a979-9d65e232a6d8';
const NOW = Date.parse('2026-11-10T00:00:00Z');

describe('signed write buttons', () => {
  const saved = process.env.CALLBACK_SIGNING_SECRET;
  beforeEach(() => { process.env.CALLBACK_SIGNING_SECRET = 'test-key'; });
  afterEach(() => { vi.unstubAllEnvs(); if (saved === undefined) delete process.env.CALLBACK_SIGNING_SECRET; else process.env.CALLBACK_SIGNING_SECRET = saved; });

  it('signs writes, leaves reads', () => {
    expect(signPayload(`ia:a:l:${UUID}`, NOW)).toMatch(/^ia:a:l:[0-9a-f-]+~[0-9a-z]+~[\w-]{8}$/);
    expect(signPayload('cb:i', NOW)).toBe('cb:i');
    expect(signPayload(`cb:o:ld:${UUID}`, NOW)).toBe(`cb:o:ld:${UUID}`);
  });

  it('round-trips and expires after 3 days', () => {
    const s = signPayload(`ia:d:b:${UUID}`, NOW);
    expect(unwrapPress(s, NOW + 1000)).toEqual({ ok: true, payload: `ia:d:b:${UUID}` });
    expect(unwrapPress(s, NOW + WRITE_BUTTON_TTL_MS + 120_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects forged or tampered tails', () => {
    const s = signPayload(`ia:a:l:${UUID}`, NOW);
    const other = s.replace(UUID, '11111111-1111-1111-1111-111111111111');
    expect(unwrapPress(other, NOW)).toEqual({ ok: false, reason: 'forged' });
    const [p, , sig] = s.split('~');
    expect(unwrapPress(`${p}~zzzzzz~${sig}`, NOW)).toEqual({ ok: false, reason: 'forged' });
    expect(unwrapPress('ia:a:l:1~a~b~c', NOW).ok).toBe(false);
  });

  it('unsigned writes only until legacy cutoff', () => {
    vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', '');
    expect(unwrapPress(`ia:a:l:${UUID}`, LEGACY_UNSIGNED_UNTIL_MS - 1).ok).toBe(true);
    expect(unwrapPress(`ia:a:l:${UUID}`, LEGACY_UNSIGNED_UNTIL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(unwrapPress('cb:i', LEGACY_UNSIGNED_UNTIL_MS + 1)).toEqual({ ok: true, payload: 'cb:i' });
  });

  it('every write builder is signed and within 64 bytes', () => {
    const all = [
      ...chatAnswerButtons(null, 'stay_booking', UUID).map((b) => b.payload),
      answerPressPayload(true, UUID), odOpen(UUID),
      cabinetPayload.taskDone(UUID), cabinetPayload.taskTomorrow(UUID),
      cabinetPayload.editTour(UUID, 9), cabinetPayload.docSaveField(UUID, 12), cabinetPayload.docTour(UUID, 9),
      cabinetPayload.inviteAccept(UUID), cabinetPayload.vehicleActive(UUID, true),
      cabinetPayload.dateClose('123456', '2026-12-31'), cabinetPayload.teamLeaveYes(),
      adminLeadPayload('contacted', UUID), adminLeadPayload('lost', UUID),
      adminAnswerPayload(true, UUID), adminAnswerPayload(false, UUID), adminTourPayload(UUID, 7),
    ];
    for (const p of all) {
      expect(isWritePayload(p.split('~')[0]!)).toBe(true);
      expect(p.split('~')).toHaveLength(3);
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    }
  });

  it('admin in MAX: marks and answers are signed, opening a lead card is a read', () => {
    vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', '');
    expect(adminOpenLeadPayload(UUID)).toBe(`ad:o:${UUID}`);
    expect(unwrapPress(`ad:o:${UUID}`, LEGACY_UNSIGNED_UNTIL_MS + 1)).toEqual({ ok: true, payload: `ad:o:${UUID}` });
    const yes = adminAnswerPayload(true, UUID);
    expect(unwrapPress(yes)).toEqual({ ok: true, payload: `ad:y:${UUID}` });
    expect(unwrapPress(`ad:y:${UUID}`, LEGACY_UNSIGNED_UNTIL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(unwrapPress(yes.replace('ad:y:', 'ad:n:'))).toEqual({ ok: false, reason: 'forged' });
  });
});

describe('without a key', () => {
  it('passes through', () => {
    const keys = ['CALLBACK_SIGNING_SECRET', 'MAX_WEBHOOK_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'MAX_BOT_TOKEN'];
    const prev = keys.map((k) => process.env[k]);
    keys.forEach((k) => { delete process.env[k]; });
    expect(signPayload(`ia:a:l:${UUID}`, NOW)).toBe(`ia:a:l:${UUID}`);
    expect(unwrapPress(`ia:a:l:${UUID}`, NOW).ok).toBe(true);
    keys.forEach((k, i) => { if (prev[i] !== undefined) process.env[k] = prev[i]; });
  });
});
