/**
 * Веб-поиск Кузьмича не отправляет телефон и почту туриста в чужой поиск
 * (аудит 15.10, Д4-2).
 *
 * searchWeb зовут три места: инструмент search_kamchatka, промах get_place_info
 * и оба запасных пути ответа — последние два передают СООБЩЕНИЕ ТУРИСТА как
 * есть (userContent). Tavily и Brave — получатели в США; крон kb-gap тот же
 * текст перед тем же поиском чистил, а Кузьмич — нет. Чистка теперь в самой
 * двери searchWeb, и сторож судит её вызовом: что ушло в fetch.
 *
 * Второе: каждый хост, в который стучится веб-поиск, назван в реестре
 * SEARCH_ENDPOINTS с юрисдикцией — реестр без потребителя был бы объявлением
 * без источника (CLAUDE.md, правило 10.09).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { SEARCH_ENDPOINTS, extractLLMHosts } from '@/lib/agents/compliance/provider-registry';

const fetchMock = vi.fn();
const PHONE = '+7 914 123-45-67';
const EMAIL = 'ivan.sidorov@mail.ru';
const TOURIST_TEXT = `Позвоните мне ${PHONE} или напишите ${EMAIL}, сколько стоит Авачинский`;

/** Что ушло наружу за вызов: адрес и тело каждого запроса. */
function outbound(): Array<{ host: string; text: string }> {
  return fetchMock.mock.calls.map((c) => {
    const url = String(c[0]);
    const init = (c[1] ?? {}) as { body?: unknown };
    return { host: new URL(url).hostname, text: decodeURIComponent(url) + ' ' + String(init.body ?? '') };
  });
}

function assertNoContacts(text: string) {
  expect(text).not.toContain('@');
  expect(text).not.toContain(EMAIL);
  // Ни номера целиком, ни его хвоста цифрами.
  expect(text.replace(/\D/g, '')).not.toMatch(/9141234567/);
}

beforeEach(() => {
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.BRAVE_SEARCH_API_KEY = 'test-brave';
  // Оба поиска отвечают отказом: так searchWeb проходит все ступени, и
  // сторож видит каждый хост, куда уходит текст.
  fetchMock.mockReset().mockImplementation(async () => new Response('fail', { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
});

describe('searchWeb: текст туриста уходит в поиск без телефона и почты', () => {
  it('search_kamchatka: Tavily и Brave получают [телефон]/[email], не контакты', async () => {
    const text = await executeKuzmichTool('search_kamchatka', { query: TOURIST_TEXT });
    expect(text).toBe('Поиск не дал результатов.');
    const sent = outbound();
    expect(sent.map((s) => s.host)).toEqual(['api.tavily.com', 'api.search.brave.com']);
    for (const s of sent) {
      assertNoContacts(s.text);
      expect(s.text).toContain('[телефон]');
      expect(s.text).toContain('[email]');
      // Смысл запроса остался — чистка режет контакты, а не вопрос.
      expect(s.text).toContain('Авачинский');
    }
  });

  it('длинное сообщение: номер на границе обрезки 200 знаков не уходит обрубком', async () => {
    // Номер начинается на 190-м знаке: обрезка до чистки оставила бы
    // «+7 914 12» — меньше 10 цифр, redactPII такое телефоном не считает.
    const long = `${'а'.repeat(189)} ${PHONE} Камчатка`;
    await executeKuzmichTool('search_kamchatka', { query: long });
    for (const s of outbound()) expect(s.text.replace(/\s/g, '')).not.toMatch(/\+791412/);
  });
});

describe('реестр внешних получателей поиска (SEARCH_ENDPOINTS)', () => {
  it('каждый хост, куда стучится веб-поиск Кузьмича, назван с юрисдикцией', async () => {
    await executeKuzmichTool('search_kamchatka', { query: 'Авачинский вулкан' });
    const hosts = new Set(outbound().map((s) => s.host));
    expect(hosts.size).toBeGreaterThan(0);
    const registered = new Map(SEARCH_ENDPOINTS.map((e) => [e.host, e]));
    for (const h of hosts) {
      const entry = registered.get(h);
      expect(entry, `хост веб-поиска ${h} не в SEARCH_ENDPOINTS`).toBeDefined();
      expect(entry?.jurisdiction).toBeTruthy();
      expect(entry?.domestic).toBe(false);
    }
  });

  it('крон kb-gap ходит в те же поисковые хосты, и все они в реестре', () => {
    // Артефакт, а не литерал: хосты, извлечённые тем же сканером, что у D2.
    const hosts = extractLLMHosts(readFileSync('app/api/cron/kb-gap/route.ts', 'utf8'));
    expect(hosts.length).toBeGreaterThan(0);
    const registered = new Set(SEARCH_ENDPOINTS.map((e) => e.host));
    for (const h of hosts) expect(registered.has(h), `kb-gap: хост ${h} не в SEARCH_ENDPOINTS`).toBe(true);
  });
});
