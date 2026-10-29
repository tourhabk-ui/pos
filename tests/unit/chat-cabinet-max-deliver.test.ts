/**
 * Доставка экрана кабинета в MAX (lib/chat-cabinet/max-deliver) — вызовом с
 * подменённым клиентом MAX.
 *
 * Держит:
 *  - кнопка экрана правит сообщение с кнопкой; MAX не принял правку или
 *    бросил — экран новым сообщением, а не тишина;
 *  - без сообщения для правки — новое сообщение;
 *  - беда в тексте человека — блок 112 ОТДЕЛЬНЫМ сообщением перед экраном, а
 *    не над ним: первая же кнопка экрана правит его сообщение и стёрла бы блок.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverCabinetMax } from '@/lib/chat-cabinet/max-deliver';
import type { CabinetScreen } from '@/lib/chat-cabinet/screens';

const SCREEN: CabinetScreen = {
  text: '<b>Входящие</b>\nЖдут ответа: 1',
  rows: [[{ text: '1. Бронь', payload: 'cb:o:ob:501' }], [{ text: 'Входящие', payload: 'cb:i' }]],
  pd: false,
};

function fakeApi(edit: () => Promise<unknown> = async () => ({ success: true })) {
  const calls: Array<{ op: 'edit' | 'send'; text: string; buttons: number }> = [];
  const count = (extra: unknown) =>
    ((extra as { attachments?: Array<{ payload: { buttons: unknown[][] } }> }).attachments?.[0]?.payload.buttons ?? []).flat().length;
  return {
    calls,
    api: {
      editMessage: vi.fn(async (_mid: string, extra: unknown) => {
        calls.push({ op: 'edit', text: (extra as { text: string }).text, buttons: count(extra) });
        return edit();
      }),
      sendMessageToChat: vi.fn(async (_chat: number, text: string, extra: unknown) => {
        calls.push({ op: 'send', text, buttons: count(extra) });
        return {};
      }),
    },
  };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

describe('экран кабинета в MAX', () => {
  it('кнопка экрана правит её сообщение; без сообщения — новое', async () => {
    let f = fakeApi();
    await deliverCabinetMax(f.api, 1, SCREEN, 'mid-1');
    expect(f.calls).toEqual([{ op: 'edit', text: SCREEN.text, buttons: 2 }]);
    f = fakeApi();
    await deliverCabinetMax(f.api, 1, SCREEN, null);
    expect(f.calls).toEqual([{ op: 'send', text: SCREEN.text, buttons: 2 }]);
  });

  it('правку MAX не принял или бросил — экран новым сообщением', async () => {
    for (const edit of [async () => ({ success: false }), async () => { throw new TypeError('сеть'); }]) {
      const f = fakeApi(edit);
      await deliverCabinetMax(f.api, 1, SCREEN, 'mid-1');
      expect(f.calls.map((c) => c.op)).toEqual(['edit', 'send']);
      expect(f.calls[1]).toEqual({ op: 'send', text: SCREEN.text, buttons: 2 });
    }
  });

  it('беда в тексте — блок 112 отдельным сообщением перед экраном; экран без блока', async () => {
    const f = fakeApi();
    await deliverCabinetMax(f.api, 1, SCREEN, null, 'входящие, человек упал со скалы, помогите');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.op).toBe('send');
    expect(f.calls[0]!.text).toContain('112');
    expect(f.calls[0]!.buttons).toBe(0);
    expect(f.calls[1]).toEqual({ op: 'send', text: SCREEN.text, buttons: 2 });
  });

  it('без беды — блока нет', async () => {
    const f = fakeApi();
    await deliverCabinetMax(f.api, 1, SCREEN, null, 'входящие');
    expect(f.calls).toEqual([{ op: 'send', text: SCREEN.text, buttons: 2 }]);
  });
});
