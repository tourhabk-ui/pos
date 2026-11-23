// @vitest-environment jsdom
/**
 * Канал уведомлений до витрины (план готовности 23.11, этап 3b).
 *
 * Заявка туриста уходит партнёру в MAX или Telegram: партнёр на витрине без
 * привязанного чата её не получит. Правило одно — `storefrontChannelGate`:
 * карточку, которой приходят заявки, нельзя ВПЕРВЫЕ поставить на витрину без
 * канала. Исходов три: есть, нет и «не смог проверить» — третий не равен
 * первому. Сами двери на настоящей базе —
 * tests/integration/storefront-channel-gate.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const { reachForPartner } = vi.hoisted(() => ({ reachForPartner: vi.fn() }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import {
  storefrontChannelGate, receivesRequests, REQUEST_RECEIVING_CATEGORIES,
  NO_CHANNEL_TEXT, CHANNEL_UNKNOWN_TEXT, NEW_CARD_NOT_PUBLIC_TEXT,
} from '@/lib/partners/storefront-gate';
import { CONNECT_CHANNEL_HELP, OPERATORS, GUIDES } from '@/lib/help/content';
import { JOIN_COMMON } from '@/lib/partners/join-pages';

beforeEach(() => reachForPartner.mockReset());
afterEach(() => cleanup());

const reach = (over: Record<string, unknown>) => ({ telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false, ...over });

describe('storefrontChannelGate', () => {
  it('MAX или Telegram есть — на витрину можно', async () => {
    reachForPartner.mockResolvedValue(reach({ maxChatId: '1', reachable: true }));
    expect(await storefrontChannelGate('p1', 'operator')).toEqual({ outcome: 'ok' });
    reachForPartner.mockResolvedValue(reach({ telegramChatId: '2', telegramSource: 'user', reachable: true }));
    expect(await storefrontChannelGate('p1', 'stay')).toEqual({ outcome: 'ok' });
  });

  it('ни MAX, ни Telegram — нет', async () => {
    reachForPartner.mockResolvedValue(reach({}));
    expect(await storefrontChannelGate('p1', 'transfer')).toEqual({ outcome: 'no_channel' });
  });

  it('не смог прочитать — «не знаю», а не «можно»', async () => {
    reachForPartner.mockResolvedValue(null);
    expect(await storefrontChannelGate('p1', 'guide')).toEqual({ outcome: 'unknown' });
  });

  it('категории без заявок канал не спрашивают — базу не трогаем', async () => {
    for (const category of ['restaurant', 'agent', 'souvenir', '', null, undefined]) {
      expect(await storefrontChannelGate('p1', category), String(category)).toEqual({ outcome: 'exempt' });
    }
    expect(reachForPartner).not.toHaveBeenCalled();
  });

  it('заявки приходят шести ролям — и прокату автомобилей тоже', () => {
    expect([...REQUEST_RECEIVING_CATEGORIES].sort()).toEqual(['cars', 'gear', 'guide', 'operator', 'stay', 'transfer']);
    expect(receivesRequests('cars')).toBe(true);
    expect(receivesRequests('agent')).toBe(false);
  });

  it('отказы называют, что делать, и не обещают лишнего', () => {
    expect(NO_CHANNEL_TEXT).toContain('ни MAX, ни Telegram');
    expect(NO_CHANNEL_TEXT).toContain('«Мессенджеры для заявок»');
    expect(CHANNEL_UNKNOWN_TEXT).toContain('Карточка не изменена');
    expect(NEW_CARD_NOT_PUBLIC_TEXT).toContain('после подключения');
  });
});

describe('статус блока «Заявки в Telegram и MAX»', () => {
  it('подключены — когда заявка дойдёт: MAX или Telegram', async () => {
    const { requestsChannelStatus } = await vi.importActual<typeof import('@/lib/partners/reach')>('@/lib/partners/reach');
    const base = { telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false } as const;
    // Один MAX: до 23.11 это читалось как «Не подключены».
    expect(requestsChannelStatus({ ...base, maxChatId: '1', reachable: true })).toBe('connected');
    expect(requestsChannelStatus({ ...base, telegramChatId: '2', telegramSource: 'partner', reachable: true })).toBe('connected');
    expect(requestsChannelStatus({ ...base })).toBe('not_connected');
    expect(requestsChannelStatus(null)).toBe('unknown');
  });
});

describe('экран очереди: отказ одобрения виден', () => {
  it('карточка показывает слова двери рядом с кнопками', async () => {
    const { OperatorCard } = await import('@/app/hub/admin/operators/_OperatorsClient');
    const op = {
      id: 'p1', company_name: 'Тест', category: 'operator', profile_status: 'pending', email: 'x@example.com',
      has_telegram: false, has_max: false, has_account: true, is_test: false, widget_enabled: false, widget_domains: [],
    } as unknown as Parameters<typeof OperatorCard>[0]['op'];
    const view = render(
      <OperatorCard op={op} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} actionError={NO_CHANNEL_TEXT} />,
    );
    expect(screen.getByRole('alert').textContent).toBe(NO_CHANNEL_TEXT);
    view.rerender(
      <OperatorCard op={op} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('админка: карточка без канала помечена «Нет канала»', () => {
  const card = async (over: Record<string, unknown>) => {
    const { OperatorCard } = await import('@/app/hub/admin/operators/_OperatorsClient');
    const op = {
      id: 'p1', company_name: 'Тест', category: 'operator', profile_status: 'approved', email: 'x@example.com',
      has_telegram: false, has_max: false, has_account: true, is_test: false, widget_enabled: false, widget_domains: [],
      ...over,
    } as unknown as Parameters<typeof OperatorCard>[0]['op'];
    return render(
      <OperatorCard op={op} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />,
    );
  };

  it('ни MAX, ни Telegram — пометка есть, и она говорит о заявках', async () => {
    const view = await card({});
    const badge = screen.getByText('Нет канала');
    expect(badge.getAttribute('title')).toContain('заявки до партнёра не дойдут');
    view.unmount();
  });

  it('пометка стоит у каждой категории, которой приходят заявки', async () => {
    for (const category of REQUEST_RECEIVING_CATEGORIES) {
      const view = await card({ category });
      expect(screen.queryByText('Нет канала'), category).not.toBeNull();
      view.unmount();
    }
  });

  it('есть MAX или Telegram — пометки нет', async () => {
    for (const over of [{ has_max: true }, { has_telegram: true }]) {
      const view = await card(over);
      expect(screen.queryByText('Нет канала')).toBeNull();
      view.unmount();
    }
  });

  it('агенту канал не нужен — пометки нет', async () => {
    const view = await card({ category: 'agent' });
    expect(screen.queryByText('Нет канала')).toBeNull();
    view.unmount();
  });

  it('канал не прочитан — пометки нет: «не знаю» не выдаётся за «нет»', async () => {
    const view = await card({ has_telegram: undefined, has_max: undefined });
    expect(screen.queryByText('Нет канала')).toBeNull();
    view.unmount();
  });
});

describe('справка: шаг подключения — одними словами у всех ролей', () => {
  it('оператор и гид читают одну и ту же фразу', () => {
    expect(JSON.stringify(OPERATORS)).toContain(CONNECT_CHANNEL_HELP);
    expect(JSON.stringify(GUIDES)).toContain(CONNECT_CHANNEL_HELP);
    for (const word of ['«Подключить MAX»', '«Подключить Telegram»', '«Старт»', '72 часа']) {
      expect(CONNECT_CHANNEL_HELP, word).toContain(word);
    }
  });

  it('страницы ролей называют те же кнопки', () => {
    const steps = JOIN_COMMON.steps.join(' ');
    expect(steps).toContain('«Подключить MAX»');
    expect(steps).toContain('«Подключить Telegram»');
  });

  it('гиду сказано, зачем: без канала профиль не выйдет в реестр', () => {
    expect(JSON.stringify(GUIDES)).toContain('без них профиль не выйдет в реестр гидов');
  });
});
