/**
 * Уведомление партнёра о сообщении в чате турист ↔ оператор/гид.
 *
 * Контракты: первое непрочитанное сообщение в беседе уходит партнёру его же
 * адресом (reachForPartner) через sendPdAlert — полный текст только туда,
 * куда дверь ПД пускает; серия непрочитанных не плодит уведомлений;
 * сообщение самого партнёра его не будит; любой отказ доставки/базы
 * проглатывается и не роняет отправку сообщения.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...args: unknown[]) => poolQueryMock(...args) } }));

const reachMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (...args: unknown[]) => reachMock(...args) }));

const sendPdAlertMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...args: unknown[]) => sendPdAlertMock(...args) }));

import { notifyPartnerOfChatMessageQuietly } from '@/lib/notifications/chat-message';

type PdArgs = { text: string; stub: string; buttons?: Array<{ text: string; url: string }>; to?: { maxChatId: string | null; telegramChatId: string | null } };

function setupDb(unreadCount: string, opts: { partnerRole?: string; cards?: Record<string, string> } = {}) {
  const partnerRole = opts.partnerRole ?? 'operator';
  // Карточки партнёра по категории: по умолчанию у собеседника есть карточка
  // ровно его роли.
  const cards = opts.cards ?? { [partnerRole === 'guide' ? 'guide' : 'operator']: 'partner-1' };
  poolQueryMock.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('COUNT(cm.id)')) return Promise.resolve({ rows: [{ count: unreadCount }] });
    if (sql.includes('FROM conversation_participants cp')) {
      return Promise.resolve({ rows: [
        { user_id: 'tourist-1', role: 'tourist', name: 'Иван Турист', subject: 'Тур на Толбачик' },
        { user_id: 'op-user-1', role: partnerRole, name: 'Оператор', subject: 'Тур на Толбачик' },
      ] });
    }
    if (sql.includes('FROM partners')) {
      const id = cards[String(params?.[1])];
      return Promise.resolve({ rows: id ? [{ id }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reachMock.mockResolvedValue({ telegramChatId: '55', maxChatId: '77', telegramSource: 'partner', reachable: true });
  sendPdAlertMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено в MAX' });
});

describe('notifyPartnerOfChatMessageQuietly', () => {
  it('первое непрочитанное: одно уведомление адресом партнёра, ПД — только в полном тексте', async () => {
    setupDb('1');
    await notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'Здравствуйте! Есть ли места на субботу?');

    expect(reachMock).toHaveBeenCalledWith('partner-1');
    expect(sendPdAlertMock).toHaveBeenCalledTimes(1);
    const arg = sendPdAlertMock.mock.calls[0][0] as PdArgs;
    expect(arg.to).toEqual({ maxChatId: '77', telegramChatId: '55' });
    expect(arg.text).toContain('Новое сообщение в чате Ведара');
    expect(arg.text).toContain('Иван Турист');
    expect(arg.text).toContain('Тур на Толбачик');
    expect(arg.text).toContain('Есть ли места');
    expect(arg.stub).not.toContain('Иван Турист');
    expect(arg.stub).not.toContain('Есть ли места');
    expect(arg.buttons?.[0].url).toMatch(/\/hub\/operator$/);
  });

  it('текст сообщения в уведомлении обрезан до 200 символов', async () => {
    setupDb('1');
    await notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'д'.repeat(500));
    const arg = sendPdAlertMock.mock.calls[0][0] as PdArgs;
    expect(arg.text).not.toContain('д'.repeat(201));
  });

  it('серия непрочитанных (партнёр ещё не читал): повторных уведомлений нет', async () => {
    setupDb('3');
    await notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'ещё одно сообщение');
    expect(sendPdAlertMock).not.toHaveBeenCalled();
  });

  it('сообщение написал сам партнёр — его не уведомляем', async () => {
    setupDb('1');
    await notifyPartnerOfChatMessageQuietly('conv-1', 'op-user-1', 'Отвечаю вам');
    expect(sendPdAlertMock).not.toHaveBeenCalled();
  });

  it('отказ доставки и отказ базы проглатываются: функция не бросает', async () => {
    setupDb('1');
    sendPdAlertMock.mockRejectedValue(new Error('MAX down'));
    await expect(notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'привет')).resolves.toBeUndefined();

    poolQueryMock.mockRejectedValue(Object.assign(new Error('db down'), { code: '57P01' }));
    await expect(notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'привет')).resolves.toBeUndefined();
  });

  // 29.10: тур продаёт и гид (1338). Беседа с карточки его тура записывает
  // собеседника с ролью гида — уведомление идёт карточке гида и ведёт в
  // кабинет гида.
  it('беседа по туру гида: уведомление адресовано карточке гида, ссылка — в кабинет гида', async () => {
    setupDb('1', { partnerRole: 'guide', cards: { guide: 'guide-card-1' } });
    await notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'Есть места на субботу?');

    const partnerLookup = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('FROM partners'));
    expect(partnerLookup?.[1]).toEqual(['op-user-1', 'guide']);
    expect(reachMock).toHaveBeenCalledWith('guide-card-1');
    expect(sendPdAlertMock).toHaveBeenCalledTimes(1);
    const arg = sendPdAlertMock.mock.calls[0][0] as PdArgs;
    expect(arg.buttons?.[0].url).toMatch(/\/hub\/guide$/);
  });

  // Беседа, начатая до 29.10, записала гида «оператором»: карточки оператора
  // у него нет. Раньше выход был молчаливым — теперь причина в логе.
  it('карточки роли нет — уведомления нет, причина названа в логе', async () => {
    setupDb('1', { partnerRole: 'operator', cards: { guide: 'guide-card-1' } });
    await notifyPartnerOfChatMessageQuietly('conv-7', 'tourist-1', 'Есть места?');
    expect(sendPdAlertMock).not.toHaveBeenCalled();
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('беседа conv-7');
    expect(logged).toContain('нет карточки категории «operator»');
    // В лог не уходят ни имя туриста, ни текст сообщения.
    expect(logged).not.toContain('Иван Турист');
    expect(logged).not.toContain('Есть места');
  });

  it('счёт непрочитанных не вернулся — причина в логе, а не тишина', async () => {
    setupDb('1');
    const base = poolQueryMock.getMockImplementation()!;
    poolQueryMock.mockImplementation((sql: string, params?: unknown[]) => (
      String(sql).includes('COUNT(cm.id)') ? Promise.resolve({ rows: [] }) : base(sql, params)
    ));
    await notifyPartnerOfChatMessageQuietly('conv-8', 'tourist-1', 'привет');
    expect(sendPdAlertMock).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join('\n')).toContain('счёт непрочитанных у партнёра partner-1 не вернулся');
  });

  it('канала у партнёра нет — отправки нет, функция не бросает', async () => {
    setupDb('1');
    reachMock.mockResolvedValue({ telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false });
    await expect(notifyPartnerOfChatMessageQuietly('conv-1', 'tourist-1', 'привет')).resolves.toBeUndefined();
    expect(sendPdAlertMock).not.toHaveBeenCalled();
  });
});
