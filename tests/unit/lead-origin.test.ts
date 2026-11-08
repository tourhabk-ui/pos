/**
 * Откуда заявка — человек или ИИ-агент и каким путём (слово владельца 08.11:
 * «нужно писать, откуда лиды — человек или ИИ и через какой инструмент: ТГ,
 * MAX, MCP, A2A или на сайте Кузьмич»).
 *
 * Судится вызовом правила (lib/leads/origin) на граничных данных: записанный
 * вход, старые заявки через инструменты без входа (след согласия и отсечка
 * 06.11), формы сайта, чужие страницы, «не записано». Канал лида
 * (lib/leads/channel) и вход вызова (lib/leads/entry-context) — тем же
 * способом. Что граница вызова ставит вход на деле — lead-entry-stamp.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { AGENT_CONSENT_SOURCE, HUMAN_CONSENT_SOURCE } from '@/lib/mcp/request-status';
import {
  AGENT_CONSENT, CHAT_CONSENT_RECORDED_SINCE, HUMAN_CONFIRMED_CONSENT, leadOrigin, leadPageUrl, withLeadOrigin,
} from '@/lib/leads/origin';
import { LEAD_ENTRIES } from '@/lib/leads/entry-values';
import { LEAD_CHANNELS, normalizeLeadChannel } from '@/lib/leads/channel';
import { leadEntryOf } from '@/lib/leads/entry-context';

const AFTER = '2026-11-07T03:00:00Z';
const BEFORE = '2026-11-03T03:00:00Z';

describe('каналы согласия — те же, что у страницы заявки', () => {
  it('литералы модуля равны константам lib/mcp/request-status', () => {
    expect(AGENT_CONSENT).toBe(AGENT_CONSENT_SOURCE);
    expect(HUMAN_CONFIRMED_CONSENT).toBe(HUMAN_CONSENT_SOURCE);
  });
});

describe('записанный вход (с 08.11)', () => {
  it.each([
    [{ entry: 'mcp', tool: 'create_booking_request' }, 'agent', 'ИИ-агент · MCP · заявка на тур'],
    [{ entry: 'a2a', tool: 'create_trip_request' }, 'agent', 'ИИ-агент · A2A · поездка целиком'],
    [{ entry: 'kuzmich-tg', tool: 'request_charter' }, 'human', 'Человек · Кузьмич в Telegram · машина под заказ'],
    [{ entry: 'kuzmich-max', tool: 'create_car_rental_request' }, 'human', 'Человек · Кузьмич в MAX · прокат машины'],
    [{ entry: 'kuzmich-web', tool: 'create_lead' }, 'human', 'Человек · Кузьмич на сайте · подбор тура'],
  ])('%j → %s', (data, actor, label) => {
    const o = leadOrigin({ source_url: 'mcp://vedar', source_data: { source: 'mcp', ...data } });
    expect(o.actor).toBe(actor);
    expect(o.label).toBe(label);
  });

  it('у каждого входа есть кто отправил и путь словами', () => {
    for (const entry of LEAD_ENTRIES) {
      const o = leadOrigin({ source_data: { entry } });
      expect(o.actor, entry).not.toBeNull();
      expect(o.via, entry).not.toBe(entry);
    }
  });

  it('вход сильнее следа согласия: заявка A2A с подтверждением человека — всё равно агент', () => {
    const o = leadOrigin({ source_data: { source: 'mcp', entry: 'a2a' }, pd_consent_source: HUMAN_CONFIRMED_CONSENT });
    expect(o.actor).toBe('agent');
    expect(o.via).toBe('A2A');
  });

  it('незнакомый инструмент — без «что за заявка», а не сырым именем', () => {
    const o = leadOrigin({ source_data: { entry: 'mcp', tool: 'make_trip_plan' } });
    expect(o.what).toBeNull();
    expect(o.label).toBe('ИИ-агент · MCP');
  });
});

describe('старые заявки через инструменты: вход не записывался', () => {
  const OLD = { source_url: 'mcp://vedar/booking', source_data: { source: 'mcp', tool: 'create_booking_request' } };

  it('согласие из чата Кузьмича — человек и его мессенджер', () => {
    const o = leadOrigin({ ...OLD, pd_consent_source: 'kuzmich-max', created_at: BEFORE });
    expect(o.actor).toBe('human');
    expect(o.label).toBe('Человек · Кузьмич в MAX · заявка на тур');
  });

  it.each([AGENT_CONSENT, HUMAN_CONFIRMED_CONSENT])('согласие %s после отсечки — ИИ-агент, MCP или A2A', (consent) => {
    const o = leadOrigin({ ...OLD, pd_consent_source: consent, created_at: AFTER });
    expect(o.actor).toBe('agent');
    expect(o.via).toContain('MCP или A2A');
  });

  it('согласие mcp до отсечки — кто отправил, не записано: чат тогда тоже писал mcp', () => {
    const o = leadOrigin({ ...OLD, pd_consent_source: AGENT_CONSENT, created_at: BEFORE });
    expect(o.actor).toBeNull();
    expect(o.label).toContain('Кто отправил — не записано');
    expect(o.label).toContain('чат Кузьмича');
  });

  it('ровно на отсечке — уже агент; дата объектом и строкой читаются одинаково', () => {
    const at = new Date(CHAT_CONSENT_RECORDED_SINCE);
    expect(leadOrigin({ ...OLD, pd_consent_source: AGENT_CONSENT, created_at: at }).actor).toBe('agent');
    expect(leadOrigin({ ...OLD, pd_consent_source: AGENT_CONSENT, created_at: CHAT_CONSENT_RECORDED_SINCE }).actor).toBe('agent');
    expect(leadOrigin({ ...OLD, pd_consent_source: AGENT_CONSENT, created_at: new Date(at.getTime() - 1) }).actor).toBeNull();
  });

  it('нет даты или она не читается — не записано, а не агент', () => {
    expect(leadOrigin({ ...OLD, pd_consent_source: AGENT_CONSENT }).actor).toBeNull();
    expect(leadOrigin({ ...OLD, pd_consent_source: AGENT_CONSENT, created_at: 'вчера' }).actor).toBeNull();
  });

  it('адрес mcp:// без источника — тот же путь', () => {
    const o = leadOrigin({ source_url: 'mcp://vedar', pd_consent_source: 'kuzmich-tg' });
    expect(o.label).toBe('Человек · Кузьмич в Telegram');
  });
});

describe('формы сайта и боты', () => {
  it.each([
    ['trip_planner', 'Человек · сайт, планер поездки'],
    ['telegram_bot', 'Человек · Telegram-бот Кузьмича'],
    ['max_bot', 'Человек · MAX-бот Кузьмича'],
    ['partner_widget', 'Человек · виджет на сайте партнёра'],
    ['transfer_page', 'Человек · сайт, страница перевозчика'],
  ])('%s → %s', (source, label) => {
    expect(leadOrigin({ source_data: { source } }).label).toBe(label);
  });

  it('человек пришёл на форму по ссылке из ответа ИИ-агента — так и сказано', () => {
    const o = leadOrigin({ source_data: { source: 'request_page', mcp_handoff_id: '7f1c0000-0000-4000-8000-000000000000' } });
    expect(o.actor).toBe('human');
    expect(o.label).toBe('Человек · сайт, страница заявки, по ссылке от ИИ-агента');
  });

  it('чат виджета до 15.10 — человек', () => {
    expect(leadOrigin({ source_data: { type: 'widget' } }).label).toBe('Человек · чат виджета на сайте партнёра');
  });
});

describe('форма без источника — страница словами', () => {
  it.each([
    ['https://vedarai.ru/routes/abc?utm_source=x#top', 'Человек · сайт, /routes/abc'],
    ['https://www.vedarai.ru/', 'Человек · сайт, главная'],
    ['https://vedarai.ru/?ref=1', 'Человек · сайт, главная'],
    ['/', 'Человек · сайт, главная'],
    ['/planner?x=1', 'Человек · сайт, /planner'],
    ['https://www.partner.ru/tours', 'Человек · страница partner.ru/tours'],
  ])('%s → %s', (url, label) => {
    expect(leadOrigin({ source_url: url }).label).toBe(label);
  });

  it('логин и пароль из адреса в подпись не попадают', () => {
    const label = leadOrigin({ source_url: 'https://user:secret@partner.ru/x' }).label;
    expect(label).toBe('Человек · страница partner.ru/x');
    expect(label).not.toContain('secret');
  });

  it('длинный путь укорочен', () => {
    const via = leadOrigin({ source_url: `https://vedarai.ru/${'a'.repeat(200)}` }).via;
    expect(via.length).toBeLessThanOrEqual('сайт, '.length + 60);
    expect(via.endsWith('…')).toBe(true);
  });
});

describe('чего не знаем — так и сказано', () => {
  it('ничего не записано', () => {
    expect(leadOrigin({})).toEqual({ actor: null, via: 'не записано', what: null, label: 'не записано' });
    expect(leadOrigin({ source_url: '', source_data: null })).toMatchObject({ actor: null, label: 'не записано' });
  });

  it('незнакомый источник — «не распознано» с самим источником, а не догадка', () => {
    const o = leadOrigin({ source_data: { source: 'fax_machine' } });
    expect(o.actor).toBeNull();
    expect(o.label).toContain('не распознано');
    expect(o.label).toContain('fax_machine');
  });
});

describe('строка лида для экрана', () => {
  it('подпись есть, канала согласия наружу нет', () => {
    const row = withLeadOrigin({
      id: 'lead-1', created_at: new Date(AFTER), source_url: 'mcp://vedar', source_data: { source: 'mcp' },
      pd_consent_source: AGENT_CONSENT,
    });
    expect('pd_consent_source' in row).toBe(false);
    expect(row.id).toBe('lead-1');
    expect(row.origin.actor).toBe('agent');
  });
});

describe('адрес страницы для карточки лида', () => {
  it.each([
    ['https://vedarai.ru/request', 'https://vedarai.ru/request'],
    ['/planner', '/planner'],
    ['mcp://vedar/booking', null],
    ['javascript:alert(1)', null],
    ['', null],
    [null, null],
  ])('%s → %s', (url, expected) => {
    expect(leadPageUrl(url)).toBe(expected);
  });
});

describe('канал лида по записанному входу', () => {
  it.each([
    ['mcp', 'mcp'],
    ['a2a', 'a2a'],
    ['kuzmich-tg', 'telegram'],
    ['kuzmich-max', 'max'],
    ['kuzmich-web', 'site_chat'],
  ])('вход %s → канал %s, хоть адрес и источник — mcp', (entry, channel) => {
    const got = normalizeLeadChannel({ source_url: 'mcp://vedar/booking', source_data: { source: 'mcp', entry } });
    expect(got).toBe(channel);
    expect(LEAD_CHANNELS).toContain(got);
  });

  it('незнакомый вход не принимается — канал по прежним признакам', () => {
    expect(normalizeLeadChannel({ source_url: 'mcp://vedar', source_data: { source: 'mcp', entry: 'fax' } })).toBe('mcp');
  });
});

describe('вход вызова инструмента', () => {
  it('согласие из чата — чат, даже если вызов шёл бы по A2A', () => {
    expect(leadEntryOf({ consentFrom: { source: 'kuzmich-max' } })).toBe('kuzmich-max');
    expect(leadEntryOf({ consentFrom: { source: 'kuzmich-web' }, via: 'a2a' })).toBe('kuzmich-web');
  });

  it('A2A — a2a, остальное — mcp', () => {
    expect(leadEntryOf({ via: 'a2a' })).toBe('a2a');
    expect(leadEntryOf({})).toBe('mcp');
  });
});
