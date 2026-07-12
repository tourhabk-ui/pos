/**
 * Ссылки в Telegram-уведомлениях о лидах.
 *
 * Баг июля 2026 (скриншоты владельца): «Обработать лид AI» вело на мёртвый
 * технический домен twc1.net (NEXTAUTH_URL на Timeweb), а «Открыть в CRM» —
 * на несуществующий /hub/admin/leads/[id] (404). Тест фиксирует:
 * ссылки строятся ТОЛЬКО от getPublicBaseUrl (канон vedarai.ru),
 * NEXTAUTH_URL игнорируется, CRM-путь указывает на живую страницу.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyOperatorNewLead } from '@/lib/notifications/lead-notify';
import { notifyAdminNewLead } from '@/lib/notifications/telegram-channel';

describe('ссылки лид-уведомлений', () => {
  const fetchMock = vi.fn();
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '123';
    // Воспроизводим прод-окружение бага: NEXTAUTH_URL смотрит на twc1
    process.env.NEXTAUTH_URL = 'https://pospkam-pospktry-c1f3.twc1.net';
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  function sentBodies(): string[] {
    return fetchMock.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? ''));
  }

  it('«Обработать лид AI» игнорирует NEXTAUTH_URL и ведёт на канон', async () => {
    await notifyOperatorNewLead({ leadId: 'lead-1', name: 'Олеся', phone: '+79619674777' });
    const body = sentBodies().join('\n');
    expect(body).toContain('vedarai.ru/hub/operator/leads/lead-1');
    expect(body).not.toContain('twc1.net');
  });

  it('«Открыть в CRM» ведёт на существующую страницу /hub/operator/leads/[id]', async () => {
    await notifyAdminNewLead({
      id: 'lead-2',
      name: 'Тест',
      phone: '+70000000000',
      comment: null,
      routeTitle: null,
      sourceUrl: null,
      score: 60,
      labelRu: 'Тёплый',
      sourceData: null,
    });
    const body = sentBodies().join('\n');
    expect(body).toContain('/hub/operator/leads/lead-2');
    expect(body).not.toContain('/hub/admin/leads/lead-2');
    expect(body).not.toContain('twc1.net');
  });
});
