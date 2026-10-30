/**
 * «Открой даты словами» (22.10, §9 спецификации): в Telegram кнопки
 * подтверждения нет — фраза туроператора про даты получает ответ «это в MAX
 * или в кабинете», записи нет, и помощник кабинета её не получает (он сказал
 * бы «открыл», не открыв). Вызов роута /api/telegram/kuzmich.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  processMessage: vi.fn(),
  processPartner: vi.fn(),
  findPartner: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/kuzmich/core', () => ({
  // Живого черновика заявки нет: развилка чата судится без него.
  hasLiveBookingFlow: vi.fn(async () => false),
  cleanupPending: vi.fn(), processMessage: m.processMessage, isBookingTrigger: () => false,
  KUZMICH_SYSTEM: '', buildTourContext: vi.fn(),
}));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  findPartnerByChat: m.findPartner,
  partnerGreeting: () => 'Здравствуйте',
  processPartnerMessage: m.processPartner,
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
}));
vi.mock('@/lib/agents', () => ({ PlatformAgent: class {} }));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok' }));
vi.mock('@/lib/platform-settings', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('@/lib/html/text', () => ({ stripTags: (s: string) => s }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => ({ success: true })) } }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: vi.fn(async () => ({ ok: true })) }));

const route = await import('@/app/api/telegram/kuzmich/route');

const CHAT = 5151;
const operator = { partnerId: 'p-1', partnerName: 'Местечко', category: 'operator', crmCategory: 'operator', userId: 'u-1' };

function update(text: string) {
  return new NextRequest('http://localhost/api/telegram/kuzmich', {
    method: 'POST',
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: { message_id: 1, from: { id: CHAT, first_name: 'Павел' }, chat: { id: CHAT, type: 'private' }, text },
    }),
  });
}
function sentTexts(): string[] {
  return m.fetch.mock.calls
    .filter(([url]) => String(url).includes('/sendMessage'))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { text: string }).text);
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_OWNER_ID', '1');
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', m.fetch);
  m.query.mockResolvedValue({ rows: [] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('Telegram: фраза про даты в чате туроператора', () => {
  it('«открой» и «закрой» — ответ «это в MAX или в кабинете», помощник не зовётся, записи нет', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: operator });
    for (const text of ['открой субботы июля, 8 мест', 'закрой 5 августа', 'не открывай 3 августа']) {
      m.fetch.mockClear();
      await route.POST(update(text));
      expect(sentTexts()).toHaveLength(1);
      expect(sentTexts()[0]).toMatch(/^Открыть даты словами можно в MAX — там есть кнопка подтверждения\. Или в кабинете: \S+\/hub\/operator\/calendar$/);
    }
    expect(m.processPartner).not.toHaveBeenCalled();
    expect(m.query.mock.calls.filter((c) => /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET)\b/i.test(String(c[0])))).toEqual([]);
  });

  it('дела помощника кабинета (ревью 22.10) — помощнику, а не «это в MAX»', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: operator });
    const crm = [
      'Добавь задачу на завтра: позвонить Анне',
      'Выполнил задачу сегодня, закрой её',
      'Клиент отменил бронь на завтра, поставь задачу перезвонить',
      'Удали задачу на пятницу',
      'Выставь счёт Анне на завтра',
      'выставь цену 15000 на 3 августа',
      // Второй ревью 22.10: инструменты помощника и чужой предмет «открой».
      'Открой контакт Анны, она писала 3 августа',
      'Открой переписку с Иваном за 3 августа',
      'Открой лид от 3 августа',
      'Добавь лид Анна на 3 августа, 4 человека',
      'Открой статистику за июль',
      'Открой расписание на июль',
      'Открой список туристов на 3 августа',
      'открой доступ менеджеру с завтра',
      'добавь 2 человека в группу на 10 августа',
    ];
    for (const text of crm) await route.POST(update(text));
    expect(m.processPartner).toHaveBeenCalledTimes(crm.length);
    expect(sentTexts().filter((t) => /Открыть даты словами/.test(t))).toEqual([]);
  });

  it('пятый ревью: предмет «открой» решают туры партнёра — тур («Выставь Горелый на 5 августа») — «это в MAX», не тур — помощнику', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: operator });
    m.query.mockImplementation(async (sql: string) => (/FROM operator_tours/.test(String(sql))
      ? { rows: [{ id: 't-1', title: 'Вулкан Горелый', active: true }] }
      : { rows: [] }));
    for (const text of ['Выставь Горелый на 5 августа, 8 мест', 'Открой Горелый на субботы июля']) {
      m.fetch.mockClear();
      await route.POST(update(text));
      expect(sentTexts(), text).toHaveLength(1);
      expect(sentTexts()[0]).toMatch(/^Открыть даты словами можно в MAX/);
    }
    expect(m.processPartner).not.toHaveBeenCalled();
    for (const text of ['Открой расписание на июль', 'Добавь Иванова на 5 августа, 2 места', 'Открой Мутновский на 5 августа']) {
      await route.POST(update(text));
    }
    expect(m.processPartner).toHaveBeenCalledTimes(3);
  });

  it('не про даты — помощнику, как раньше; не туроператору фраза про даты — тоже помощнику', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: operator });
    await route.POST(update('кто ждёт ответа?'));
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...operator, category: 'transfer' } });
    await route.POST(update('открой субботы июля, 8 мест'));
    expect(m.processPartner).toHaveBeenCalledTimes(2);
  });

  it('гид со своими турами (29.10) — «это в MAX» со ссылкой в его раздел «Свои туры»; гид команды — помощнику', async () => {
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...operator, category: 'guide', crmCategory: 'guide', sellsTours: true } });
    await route.POST(update('открой субботы июля, 8 мест'));
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toMatch(/^Открыть даты словами можно в MAX — там есть кнопка подтверждения\. Или в кабинете: \S+\/hub\/guide\/own$/);
    expect(m.processPartner).not.toHaveBeenCalled();
    m.findPartner.mockResolvedValue({ outcome: 'found', partner: { ...operator, category: 'guide', crmCategory: 'guide', sellsTours: false } });
    await route.POST(update('открой субботы июля, 8 мест'));
    expect(m.processPartner).toHaveBeenCalledTimes(1);
  });
});
