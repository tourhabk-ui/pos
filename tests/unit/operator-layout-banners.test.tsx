/**
 * Раскладка кабинета оператора: какой баннер «Подключите MAX» видит человек
 * (CRM 2г-4). Рендером, а не поиском JSX в файле (CLAUDE.md §4, решение 13.10).
 *
 *  - место ещё не узнано — ни одного баннера: менеджеру не мелькнёт баннер
 *    чата кабинета со ссылкой, которую ему не выдадут;
 *  - владелец и «не узнали» — баннер чата кабинета, как было до команды;
 *  - менеджер — свой баннер: копии уведомлений в его мессенджер.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

const seat = vi.hoisted(() => ({ value: { state: 'loading' } as unknown }));
vi.mock('@/components/operator/use-operator-seat', async (orig) => ({
  ...(await orig<typeof import('@/components/operator/use-operator-seat')>()),
  useOperatorSeat: () => seat.value,
}));
vi.mock('@/components/layout/HubLayout', () => ({
  HubLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/chat/ChatWidget', () => ({ ChatWidget: () => null }));
vi.mock('@/components/operator/ForcePasswordChangeBanner', () => ({ ForcePasswordChangeBanner: () => null }));
vi.mock('@/components/hub/PartnerChannelBanner', () => ({ PartnerChannelBanner: () => <p>баннер чата кабинета</p> }));
vi.mock('@/components/operator/MemberChannelBanner', () => ({ MemberChannelBanner: () => <p>баннер менеджера</p> }));

import OperatorHubLayout from '@/app/hub/operator/layout';

const perms = { can_edit_prices: false, can_cancel_bookings: false };

afterEach(() => cleanup());

describe('баннер мессенджера в кабинете оператора', () => {
  it.each([
    ['место не узнано', { state: 'loading' }, []],
    ['владелец', { state: 'ok', kind: 'owner', perms }, ['баннер чата кабинета']],
    ['не узнали (сбой /me)', { state: 'unknown' }, ['баннер чата кабинета']],
    ['менеджер', { state: 'ok', kind: 'manager', perms }, ['баннер менеджера']],
  ])('%s', (_name, value, expected) => {
    seat.value = value;
    render(<OperatorHubLayout><main>экран</main></OperatorHubLayout>);
    expect(screen.getByText('экран')).toBeTruthy();
    const shown = ['баннер чата кабинета', 'баннер менеджера'].filter(t => screen.queryByText(t));
    expect(shown).toEqual(expected);
  });
});
