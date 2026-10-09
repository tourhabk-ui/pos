/**
 * Сторож общей двери уведомлений партнёрам без ПД (lib/partners/notice, 09.10).
 *
 * До 09.10 только напоминание оператору умело MAX; владельцу жилья, прокату,
 * перевозчику и владельцу при отмене брони жилья писали только в Telegram, и
 * партнёр с одним MAX не узнавал ни о чём, числясь «не подключённым к боту».
 * Держится: поведение двери (MAX первым, Telegram запасным, исход наружу) и
 * то, что все пять мест зовут её, а не свой fetch в Telegram.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const maxSendDm = vi.fn();
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: (...a: unknown[]) => maxSendDm(...a) }));

const { sendPartnerNotice } = await import('@/lib/partners/notice');
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const LINK = { text: 'Брони жилья', url: 'https://vedarai.ru/hub/stay/bookings' };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  maxSendDm.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal('fetch', fetchMock);
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('sendPartnerNotice', () => {
  it('MAX есть и принял — Telegram не трогается, ссылка кнопкой', async () => {
    maxSendDm.mockResolvedValueOnce({ ok: true });
    expect(await sendPartnerNotice({ maxChatId: '1', telegramChatId: '2' }, '<b>x</b>', LINK, 'тест')).toBe('max');
    expect(maxSendDm).toHaveBeenCalledWith('1', '<b>x</b>', { buttons: [LINK] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MAX отказал — запасной Telegram со ссылкой в тексте; отказ в логе', async () => {
    maxSendDm.mockResolvedValueOnce({ ok: false, error: 'chat not found' });
    expect(await sendPartnerNotice({ maxChatId: '1', telegramChatId: '2' }, 'x', LINK, 'тест')).toBe('telegram');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.chat_id).toBe('2');
    expect(body.text).toContain(`<a href="${LINK.url}">${LINK.text}</a>`);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/не ушло в MAX — chat not found/);
  });

  it('только MAX и он отказал — null, а не «ушло»', async () => {
    maxSendDm.mockResolvedValueOnce({ ok: false, error: 'x' });
    expect(await sendPartnerNotice({ maxChatId: '1', telegramChatId: null }, 'x', LINK, 'тест')).toBeNull();
  });

  it('Telegram ответил не 200 — null и причина в лог', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await sendPartnerNotice({ maxChatId: null, telegramChatId: '2' }, 'x', LINK, 'тест')).toBeNull();
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/не ушло в Telegram — HTTP 403/);
  });
});

describe('все партнёрские уведомления без ПД — через общую дверь', () => {
  const WATCHDOG = read('lib/agents/watchdog.ts');
  const fnOf = (name: string) => {
    const start = WATCHDOG.indexOf(`async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    const next = WATCHDOG.indexOf('\nasync function ', start + 10);
    return WATCHDOG.slice(start, next === -1 ? undefined : next);
  };

  for (const name of ['notifyOperatorDirectly', 'notifyStayOwnerDirectly', 'notifyGearPartnerDirectly', 'notifyTransferOperatorDirectly']) {
    it(`Watchdog: ${name} зовёт sendPartnerNotice и экранирует имя`, () => {
      const fn = fnOf(name);
      expect(fn).toMatch(/return sendPartnerNotice\(/);
      expect(fn).not.toMatch(/api\.telegram\.org/);
      expect(fn).toMatch(/escapeHtml\(/);
    });
  }

  it('Watchdog: проверки жилья, проката и перевозчика шлют по reach.reachable, а не только по Telegram', () => {
    expect(WATCHDOG).not.toMatch(/if \(reach\.telegramChatId && row\./);
    expect(WATCHDOG.match(/if \(reach\.reachable && row\.(owner_name|partner_name|operator_name)\)/g) ?? []).toHaveLength(3);
  });

  it('перевозчика ведут в его кабинет, а не в общий /hub', () => {
    expect(fnOf('notifyTransferOperatorDirectly')).toMatch(/\/hub\/carrier`/);
  });

  it('отмена брони жилья: владельцу по правилу достижимости через общую дверь', () => {
    const stay = read('lib/notifications/stay-booking.ts');
    const fn = stay.slice(stay.indexOf('export async function notifyStayBookingCancelled'));
    expect(fn).toMatch(/await reachForPartner\(p\.ownerPartnerId\)/);
    expect(fn).toMatch(/await sendPartnerNotice\(/);
    expect(fn).not.toMatch(/tgSend\(p\.ownerTelegramChatId/);
    for (const route of ['app/api/stay/bookings/[id]/cancel/route.ts', 'app/api/stay/bookings/[id]/route.ts']) {
      expect(read(route), route).toMatch(/a\.partner_id::text AS owner_partner_id/);
      expect(read(route), route).toMatch(/ownerPartnerId: outcome\.(notify\.)?ownerPartnerId/);
    }
  });
});
