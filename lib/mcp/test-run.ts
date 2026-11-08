/**
 * Пробная заявка через MCP (`test: true`) и структурный итог пишущих
 * инструментов (ревью MCP 08.11).
 *
 * Повод — живая проверка внешним агентом: демонстрационная заявка с номером
 * +70000000000 ушла настоящему менеджеру, а отменить её агент не мог. Пробный
 * режим был только у проката, и тот записывал лид «своей пробой» — менеджер
 * его всё равно видел.
 *
 * Правило пробы одно на шесть инструментов: все проверки — как у настоящей
 * заявки (тур, даты, места, сезон, телефон, согласие), но ДО записи прогон
 * останавливается. Ничего не пишется в базу, никому не уходит — ни партнёру,
 * ни менеджеру Ведара, ни в мессенджер. Остановка стоит в каждом исполнителе
 * перед допуском к записи (`admitWrite`), поэтому ни один путь доставки
 * (лид, запрос мест оператору, заявка хозяину жилья, перевозчику) пробу не
 * видит по построению, а не потому, что каждый из них помнит о метке.
 *
 * Пробный ключ (`test_…`) не хранится: get_request_status узнаёт его по виду
 * и отвечает состоянием `test`. Длина пробного ключа не совпадает с длиной
 * настоящего (32 знака), поэтому настоящий ключ пробным не прочитается.
 */
import { randomBytes } from 'node:crypto';
import { getPublicBaseUrl } from '@/lib/config';
import type { RequestKind, ConsentPurpose } from '@/lib/mcp/request-status-schema';

const TEST_KIND_TAG: Readonly<Record<RequestKind, string>> = { lead: 'lead', seat_request: 'seat', stay_request: 'stay' };
const TEST_PURPOSE_TAG: Readonly<Record<ConsentPurpose, string>> = { operator: 'op', stay: 'st', carrier: 'ca', rental: 're' };

/** test_<вид>_<цель>_<16 знаков> — 25–26 знаков; настоящий ключ — ровно 32. */
const TEST_KEY_RE = /^test_(lead|seat|stay)_(op|st|ca|re)_[A-Za-z0-9_-]{16}$/;

export function issueTestKey(kind: RequestKind, purpose: ConsentPurpose): string {
  return `test_${TEST_KIND_TAG[kind]}_${TEST_PURPOSE_TAG[purpose]}_${randomBytes(12).toString('base64url')}`;
}

export function isTestKey(key: string): boolean {
  return TEST_KEY_RE.test(key);
}

const kindOf = (tag: string): RequestKind => (tag === 'seat' ? 'seat_request' : tag === 'stay' ? 'stay_request' : 'lead');
const purposeOf = (tag: string): ConsentPurpose =>
  (tag === 'st' ? 'stay' : tag === 'ca' ? 'carrier' : tag === 're' ? 'rental' : 'operator');

/** Ответ get_request_status на пробный ключ — та же форма, что у настоящего. */
export function testKeyStatus(key: string) {
  const m = TEST_KEY_RE.exec(key);
  return {
    state: 'test' as const,
    kind: kindOf(m?.[1] ?? 'lead'),
    tour: null, accommodation: null, accommodation_url: null,
    date: null, requested_date: null, check_out: null, participants: null, alt_date: null, deadline: null,
    human: 'Пробная заявка: проверки пройдены, но она не записана и никому не передана.',
    next: 'Ничего делать не нужно. Чтобы заявка ушла адресату, повторите вызов без test: true.',
    consent: 'agent' as const,
    consent_purpose: purposeOf(m?.[2] ?? 'op'),
    page: `${getPublicBaseUrl()}/mcp`,
    partner_replies: null, partner_last_reply_at: null, max_link: null,
    notify: null,
  };
}

/**
 * Текст ответа пробы: что прошло, что ушло бы и кому — и что не ушло ничего.
 * `would` — одна фраза о заявке («Заявка оператору: тур …, дата …»), без
 * имени и телефона человека (ответ уходит в модель, pd-guard). `recipient` —
 * адресат помимо менеджера (null — заявка и так менеджеру).
 */
export function testRunText(would: string, recipient: string | null, key: string): string {
  const nobody = recipient ? `ни ${recipient}, ни менеджеру Ведара` : 'ни менеджеру Ведара, ни партнёрам';
  return `Пробная заявка (test: true): все проверки пройдены, но заявка не записана и никому не передана — ${nobody}. `
    + `Без test: true ушла бы: ${would} `
    + `Пробный ключ статуса: ${key} — get_request_status ответит состоянием test. Уведомления (notify_url) у пробы не заводятся. `
    + 'Человеку эту заявку не показывайте как принятую: её нет.';
}

// ── Структурный итог пишущих инструментов ───────────────────────────────────

/** Одна заявка, выданная вызовом: ключ, страница, подписка. */
export interface IssuedWrite {
  tool: string;
  /** accepted — заявка принята (новая или повтор — не различается, анти-оракул 29.09); test — проба. */
  outcome: 'accepted' | 'test';
  status_key: string | null;
  status_page: string | null;
  notify:
    | { active: true; ref: string; signing_secret: string }
    | { active: false; reason: string }
    | null;
}

/** structuredContent пишущего инструмента. */
export interface WriteStructured {
  test: boolean;
  /** Сколько заявок принято этим вызовом (у поездки целиком — по частям); 0 — ни одной. */
  accepted: number;
  requests: IssuedWrite[];
}

export function writeStructured(test: boolean, issued: readonly IssuedWrite[]): WriteStructured {
  return { test, accepted: issued.filter((r) => r.outcome === 'accepted').length, requests: [...issued] };
}

const NOTIFY_SCHEMA = {
  type: ['object', 'null'],
  description: 'Подписка на уведомления по notify_url: active=true — номер подписки и ключ подписи (показан один раз); active=false — не заведена, reason — почему; null — адрес не передавали',
  properties: {
    active: { type: 'boolean' },
    ref: { type: 'string', description: 'Номер подписки (nr_…)' },
    signing_secret: { type: 'string', description: 'Ключ подписи вебхука (whsec_…), Standard Webhooks; сохраните, не публикуйте' },
    reason: { type: 'string' },
  },
  required: ['active'],
} as const;

/** outputSchema шести пишущих инструментов. */
export const WRITE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    test: { type: 'boolean', description: 'Пробный прогон (test: true): ничего не записано и не передано' },
    accepted: { type: 'integer', description: 'Сколько заявок принято этим вызовом; 0 — ни одной (причина — в тексте ответа)' },
    requests: {
      type: 'array',
      description: 'Заявки этого вызова: у поездки целиком — по частям. Повтор того же вызова за сутки второй заявки не создаёт: ключ выдаётся новый, к той же заявке',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Инструмент, создавший заявку' },
          outcome: { type: 'string', enum: ['accepted', 'test'] },
          status_key: { type: ['string', 'null'], description: 'Ключ для get_request_status; null — ключ не выдан (сбой записи ключа)' },
          status_page: { type: ['string', 'null'], description: 'Страница заявки для человека; дайте её человеку, не публикуйте' },
          notify: NOTIFY_SCHEMA,
        },
        required: ['tool', 'outcome', 'status_key', 'status_page', 'notify'],
      },
    },
  },
  required: ['test', 'accepted', 'requests'],
} as const;
