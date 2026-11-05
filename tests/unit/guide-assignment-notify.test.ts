// @vitest-environment node
/**
 * Гиду — лично в MAX или Telegram: назначили на тур или сняли (05.11).
 *
 * До этого дня назначение писало только колокольчик на сайте: гид в чате
 * бота о назначении не узнавал, о снятии — никогда. Сторож держит вызов:
 * адресат — сам гид (строго, без рабочего чата платформы), в тексте тур и
 * дата словами, ПД туриста нет, название экранировано; четыре исхода
 * доставки названы; роут оператора зовёт уведомление новому и прежнему гиду.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reach = vi.fn();
const send = vi.fn();
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...a: unknown[]) => reach(...a) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => send(...a) }));
vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { notifyGuideAssignment, guideAssignmentText } from '@/lib/notifications/guide-assignment-notify';

const GUIDE = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  reach.mockResolvedValue({ reachable: true, maxChatId: '777', telegramChatId: '555' });
  send.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
});

describe('уведомление гиду о назначении', () => {
  it('назначили: лично гиду, тур и дата словами, кнопки «Расписание» и «Группы на сайте»', async () => {
    const out = await notifyGuideAssignment({ guidePartnerId: GUIDE, change: 'assigned', tourTitle: 'Вачкажец + озёрки', date: '2027-07-15' });
    expect(out).toEqual({ state: 'delivered', channel: 'max' });
    expect(reach).toHaveBeenCalledWith(GUIDE);
    const p = send.mock.calls[0][0];
    expect(p.to).toEqual({ maxChatId: '777', telegramChatId: '555' });
    expect(p.text).toMatch(/Вас назначили на тур/);
    expect(p.text).toContain('«Вачкажец + озёрки», 15 июля 2027');
    expect(p.stub).toBe(p.text);
    expect(p.buttons).toEqual([
      { text: 'Расписание', payload: 'cb:s' },
      { text: 'Группы на сайте', url: 'https://vedarai.ru/hub/guide/groups' },
    ]);
  });

  it('сняли: «Вас сняли с тура», без кнопки «Расписание»', async () => {
    await notifyGuideAssignment({ guidePartnerId: GUIDE, change: 'removed', tourTitle: 'Горелый', date: '2027-07-20' });
    const p = send.mock.calls[0][0];
    expect(p.text).toMatch(/Вас сняли с тура/);
    expect(p.text).toContain('«Горелый», 20 июля 2027');
    expect(p.buttons.map((b: { text: string }) => b.text)).toEqual(['Группы на сайте']);
  });

  it('название тура экранировано', () => {
    expect(guideAssignmentText({ guidePartnerId: GUIDE, change: 'assigned', tourTitle: '<b>x</b>', date: '2027-07-15' }))
      .toContain('«&lt;b&gt;x&lt;/b&gt;»');
  });

  it('нет канала, адрес не прочитался, отказ доставки — названы, ничего не уходит мимо гида', async () => {
    reach.mockResolvedValueOnce({ reachable: false, maxChatId: null, telegramChatId: null });
    expect(await notifyGuideAssignment({ guidePartnerId: GUIDE, change: 'assigned', tourTitle: 'Т', date: '2027-07-15' })).toEqual({ state: 'no_channel' });
    reach.mockResolvedValueOnce(null);
    expect(await notifyGuideAssignment({ guidePartnerId: GUIDE, change: 'assigned', tourTitle: 'Т', date: '2027-07-15' })).toEqual({ state: 'unknown' });
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ channel: 'none', delivered: false, reason: 'MAX не ответил' });
    expect(await notifyGuideAssignment({ guidePartnerId: GUIDE, change: 'assigned', tourTitle: 'Т', date: '2027-07-15' }))
      .toEqual({ state: 'failed', channel: 'none', reason: 'MAX не ответил' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('не доставлено'));
  });
});
