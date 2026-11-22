/**
 * Беседы с туристами в кабинете туроператора — страницей «Сообщения», а не
 * плавающей кнопкой (22.11, #2770, слово владельца «да»): на телефоне 390 px
 * кнопка накрывала «Создать тур» в редакторе тура. Рендером и вызовом, а не
 * поиском JSX в файле (CLAUDE.md §4, решение 13.10):
 *
 *  - раскладка кабинета оператора не рисует кнопку «Открыть чат», а раскладка
 *    гида с тем же входом рисует: правка задела только оператора, и проверка
 *    кнопку видит;
 *  - в меню есть «Сообщения», страница открывает беседу из уведомления по
 *    номеру и не открывает по мусору в адресе;
 *  - список бесед: есть / пусто со словами оператору / не загрузился —
 *    словами и «Повторить», а не «Нет бесед» (§4.0);
 *  - «Входящие» оператора ведут ссылкой на страницу, гида — к кнопке, как было;
 *  - «Открыть чат» в уведомлении о сообщении ведёт туда же, с номером беседы.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/hub/operator',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'op-user-1' } }) }));
vi.mock('@/components/operator/use-operator-seat', async (orig) => ({
  ...(await orig<typeof import('@/components/operator/use-operator-seat')>()),
  useOperatorSeat: () => ({ state: 'ok', kind: 'owner', perms: { can_edit_prices: true, can_cancel_bookings: true } }),
}));
vi.mock('@/components/layout/HubLayout', () => ({
  HubLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/operator/ForcePasswordChangeBanner', () => ({ ForcePasswordChangeBanner: () => null }));
vi.mock('@/components/hub/PartnerChannelBanner', () => ({ PartnerChannelBanner: () => null }));
vi.mock('@/components/operator/MemberChannelBanner', () => ({ MemberChannelBanner: () => null }));
vi.mock('@/components/chat/MessageThread', () => ({
  MessageThread: ({ conversationId }: { conversationId: string }) => <p>переписка {conversationId}</p>,
}));

import OperatorHubLayout from '@/app/hub/operator/layout';
import OperatorMessagesPage from '@/app/hub/operator/messages/page';
import GuideHubLayout from '@/app/hub/guide/layout';
import { ConversationsPanel, CONVERSATIONS_FAILED_TEXT } from '@/components/chat/ConversationsPanel';
import { OPERATOR_MENU } from '@/components/operator/operator-menu';
import { InboxScreen } from '@/components/crm/InboxScreen';
import { CRM_INBOX_API } from '@/components/crm/api';
import { OPERATOR_MESSAGES_HINT, OPERATOR_MESSAGES_PATH, partnerChatPath, inboxChatHint } from '@/lib/crm/inbox-kinds';

const CONV = '11111111-2222-4333-8444-555555555555';

const conversationRow = {
  id: CONV, type: 'direct', subject: 'Вулкан Горелый', other_participant_name: 'Турист Т.',
  other_participant_role: 'tourist', other_participant_id: 'tourist-1',
  last_message_content: 'Есть места на субботу?', last_message_at: new Date().toISOString(),
  last_message_sender_name: 'Турист Т.', unread_count: '1',
};

type Reply = { status: number; body: unknown };

function serve(routes: Record<string, Reply>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const reply = key ? routes[key] : { status: 200, body: { success: true, data: { onboarding_completed: true } } };
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }));
  return calls;
}

const conversations = (rows: unknown[]): Reply => ({ status: 200, body: { success: true, data: { conversations: rows } } });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('кабинет оператора: плавающей кнопки чата нет', () => {
  it('раскладка оператора не рисует «Открыть чат», раскладка гида с тем же входом рисует', async () => {
    serve({ '/api/chat/unread': { status: 200, body: { success: true, data: { total: 2 } } } });
    render(<OperatorHubLayout><main>редактор тура</main></OperatorHubLayout>);
    expect(await screen.findByText('редактор тура')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Открыть чат' })).toBeNull();
    cleanup();

    render(<GuideHubLayout><main>кабинет гида</main></GuideHubLayout>);
    expect(await screen.findByRole('button', { name: 'Открыть чат' })).toBeTruthy();
  });

  it('в меню есть «Сообщения» — страница бесед', () => {
    const item = OPERATOR_MENU.find((i) => i.href === OPERATOR_MESSAGES_PATH);
    expect(item?.label).toBe('Сообщения');
  });
});

describe('страница «Сообщения»', () => {
  it('беседа из уведомления (?c=номер) открыта сразу; список виден', async () => {
    serve({ '/api/chat/conversations': conversations([conversationRow]) });
    render(await OperatorMessagesPage({ searchParams: Promise.resolve({ c: CONV }) }));
    expect(await screen.findByText(`переписка ${CONV}`)).toBeTruthy();
    expect(await screen.findAllByText('Турист Т.')).not.toHaveLength(0);
  });

  it('мусор в адресе беседу не открывает: выбор — нажатием в списке', async () => {
    serve({ '/api/chat/conversations': conversations([conversationRow]) });
    render(await OperatorMessagesPage({ searchParams: Promise.resolve({ c: '../../api/x' }) }));
    expect(await screen.findByText('Выберите беседу слева')).toBeTruthy();
    expect(screen.queryByText(/^переписка /)).toBeNull();
    fireEvent.click(screen.getByText('Есть места на субботу?'));
    expect(await screen.findByText(`переписка ${CONV}`)).toBeTruthy();
  });

  it('бесед нет — слова оператору, откуда пишут туристы, а не «начните на странице тура»', async () => {
    serve({ '/api/chat/conversations': conversations([]) });
    render(<ConversationsPanel emptyHint={OPERATOR_MESSAGES_HINT} />);
    expect(await screen.findByText('Нет бесед')).toBeTruthy();
    expect(screen.getByText(OPERATOR_MESSAGES_HINT)).toBeTruthy();
    expect(screen.queryByText(/Начните общение с оператором/)).toBeNull();
  });

  it('список не загрузился — так и сказано, «Повторить» загружает снова; «Нет бесед» не говорится', async () => {
    const calls = serve({ '/api/chat/conversations': { status: 500, body: { success: false } } });
    render(<ConversationsPanel emptyHint={OPERATOR_MESSAGES_HINT} />);
    expect((await screen.findByRole('alert')).textContent).toContain(CONVERSATIONS_FAILED_TEXT);
    expect(screen.queryByText('Нет бесед')).toBeNull();
    const before = calls.filter((u) => u.startsWith('/api/chat/conversations')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await screen.findByRole('alert');
    expect(calls.filter((u) => u.startsWith('/api/chat/conversations')).length).toBe(before + 1);
  });

  it('сеть оборвалась — тот же исход «не загрузился»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<ConversationsPanel emptyHint={OPERATOR_MESSAGES_HINT} />);
    expect((await screen.findByRole('alert')).textContent).toContain(CONVERSATIONS_FAILED_TEXT);
  });
});

describe('куда ведут к чату «Входящие» и уведомление', () => {
  function serveInbox(category: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== CRM_INBOX_API) throw new Error(`неожиданный адрес ${url}`);
      return {
        ok: true, status: 200,
        json: async () => ({
          success: true,
          data: {
            category, items: [], failed: [],
            response: { window_days: 7, median_minutes: null, responded: 0, enough: false, complete: true },
            chat: { state: 'ok', unread: 3 }, not_here: [],
          },
        }),
      };
    }));
  }

  it('оператор: непрочитанное — ссылкой на «Сообщения», про кнопку внизу экрана ни слова', async () => {
    serveInbox('operator');
    render(<InboxScreen />);
    const line = (await screen.findByText(/Непрочитанных сообщений в чате: 3/)).closest('p') as HTMLElement;
    const link = line.querySelector('a');
    expect(link?.getAttribute('href')).toBe(OPERATOR_MESSAGES_PATH);
    expect(line.textContent).not.toMatch(/кнопкой внизу экрана/);
  });

  it('гид: кнопка чата в его кабинете осталась — строка про неё, без ссылки', async () => {
    serveInbox('guide');
    render(<InboxScreen />);
    const line = (await screen.findByText(/Непрочитанных сообщений в чате: 3/)).closest('p') as HTMLElement;
    expect(line.querySelector('a')).toBeNull();
    expect(line.textContent).toMatch(/кнопкой внизу экрана/);
  });

  it('адрес чата: оператору — «Сообщения» с беседой, гиду — его кабинет, прочим — нет', () => {
    expect(partnerChatPath('operator', CONV)).toBe(`${OPERATOR_MESSAGES_PATH}?c=${CONV}`);
    expect(partnerChatPath('operator')).toBe(OPERATOR_MESSAGES_PATH);
    expect(partnerChatPath('guide', CONV)).toBe('/hub/guide');
    expect(partnerChatPath('stay', CONV)).toBeNull();
    expect(inboxChatHint('operator').href).toBe(OPERATOR_MESSAGES_PATH);
    expect(inboxChatHint('guide').href).toBeNull();
  });
});
