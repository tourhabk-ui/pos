/**
 * Диалоги Кузьмича для оценки вместо судьи-модели (слово владельца 19.11 «у
 * судьи баланса нет возьми на себя его работу пока»).
 *
 * Сторож держит:
 *  · пары «вопрос — ответ» из реплик веб-чата и журнала A2A, маска до шифра:
 *    телефон, почта, «меня зовут …», ник;
 *  · тексты в ответе роута — только шифром ключом проверяющего; открытый
 *    текст вопроса и ответа не встречается в теле ни при каком исходе;
 *  · шифр открывается закрытой парой ключа, которым закрыт, — и только ей;
 *  · ключ не записан или не читается — 503, базы не трогаем или текстов нет;
 *  · отказ базы — 502 с SQLSTATE, в логе нет текста;
 *  · отпечаток ключа в коде совпадает с самим ключом;
 *  · роут объявлен в реестре ручных.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { NextRequest } from 'next/server';
import { MANUAL_ENDPOINTS, DECLARED } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import {
  buildReviewBatch, keyFingerprint, pairsFromMessages, sealForReviewer,
  type ReviewBatch, type SealedBatch,
} from '@/lib/agents/review/review-batch';
import { REVIEWER_KEY_FINGERPRINT } from '@/lib/agents/review/reviewer-key';

const { query, keyState } = vi.hoisted(() => ({ query: vi.fn(), keyState: { pem: '' } }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/agents/review/reviewer-key', async (orig) => {
  const real = await orig<typeof import('@/lib/agents/review/reviewer-key')>();
  return {
    ...real,
    get REVIEWER_PUBLIC_KEY_PEM() { return keyState.pem; },
  };
});

import { GET } from '@/app/api/cron/kuzmich-review-batch/route';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function open(sealed: SealedBatch, privateKey = pair.privateKey): string {
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(sealed.wrapped_key, 'base64'),
  );
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.ct, 'base64')), d.final()]).toString('utf8');
}

const SECRET = 'test-cron-secret';
const req = (qs = '', auth = true) => new NextRequest(
  `https://vedarai.ru/api/cron/kuzmich-review-batch${qs}`,
  { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} },
);

const PHONE = '+7 914 555-12-34';
const WEB_ROWS = [
  {
    day: '2026-11-18', role: 'tourist', messages: [
      { role: 'user', content: `Меня зовут Анна, телефон ${PHONE}. Можно ли завтра на Авачинский?` },
      { role: 'assistant', content: 'Завтра на Авачинском ветер до 20 м/с — выход лучше отложить.' },
      { role: 'user', content: 'Спасибо' },
    ],
  },
  { day: '2026-11-17', role: 'tourist', messages: [{ role: 'assistant', content: 'Здравствуйте! Чем помочь?' }] },
];
const A2A_ROWS = [
  { day: '2026-11-18', agent: 'TestAgent', is_self: false, question: 'Write to me at guest@example.com: volcano tours?', answer: 'Туров к вулканам три.' },
];

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  keyState.pem = PUB;
  query.mockReset();
  query.mockImplementation((sql: string) => Promise.resolve({
    rows: /FROM chat_sessions/.test(sql) ? WEB_ROWS : /FROM a2a_dialogs/.test(sql) ? A2A_ROWS : [],
  }));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('пары и маска', () => {
  it('вопрос человека и следующий ответ — пара; реплика без ответа и ответ без вопроса — нет', () => {
    const pairs = pairsFromMessages(WEB_ROWS[0].messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a).toContain('ветер до 20 м/с');
    expect(pairsFromMessages(WEB_ROWS[1].messages)).toEqual([]);
    expect(pairsFromMessages('не массив')).toEqual([]);
    expect(pairsFromMessages([{ role: 'user' }, { role: 'assistant', content: 'x' }])).toEqual([]);
  });

  it('телефон, имя в «меня зовут», почта — под маской до шифра', () => {
    const [p] = pairsFromMessages(WEB_ROWS[0].messages);
    expect(p.q).not.toContain('914');
    expect(p.q).not.toContain('Анна');
    expect(p.q).toContain('Авачинский');
    const batch = buildReviewBatch([], A2A_ROWS);
    expect(batch.a2a[0].pair.q).not.toContain('guest@example.com');
    expect(batch.a2a[0].agent).toBe('TestAgent');
  });

  it('не вошедшее по потолку размера — считается, а не теряется молча', () => {
    const many = Array.from({ length: 5 }, () => WEB_ROWS[0]);
    const full = buildReviewBatch(many, A2A_ROWS);
    expect(full.web).toHaveLength(5);
    expect(full.dropped).toBe(0);
    const tight = buildReviewBatch(many, A2A_ROWS, 400);
    expect(tight.web.length + tight.a2a.length).toBeLessThan(6);
    expect(tight.dropped).toBe(6 - tight.web.length - tight.a2a.length);
  });
});

describe('шифр', () => {
  it('открывается закрытым ключом своей пары; в шифре нет открытого текста', () => {
    const plain = JSON.stringify({ q: 'Авачинский завтра?' });
    const sealed = sealForReviewer(plain, PUB);
    expect(open(sealed)).toBe(plain);
    expect(JSON.stringify(sealed)).not.toContain('Авачинский');
    expect(sealed.key_fingerprint).toBe(keyFingerprint(PUB));
  });

  it('чужим закрытым ключом не открывается', () => {
    const sealed = sealForReviewer('секрет', PUB);
    expect(() => open(sealed, other.privateKey)).toThrow();
  });

  it('отпечаток в коде — от того ключа, что записан в коде', async () => {
    const real = await vi.importActual<typeof import('@/lib/agents/review/reviewer-key')>('@/lib/agents/review/reviewer-key');
    expect(keyFingerprint(real.REVIEWER_PUBLIC_KEY_PEM)).toBe(REVIEWER_KEY_FINGERPRINT);
    expect(real.REVIEWER_PUBLIC_KEY_PEM).not.toContain('PRIVATE');
  });

  it('нечитаемый ключ — исключение, а не открытый текст', () => {
    expect(() => sealForReviewer('текст', 'не ключ')).toThrow();
  });
});

describe('GET /api/cron/kuzmich-review-batch', () => {
  it('без секрета — 401, в базу не ходит', async () => {
    const res = await GET(req('', false));
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('окно и предел — параметрами; вне границ — 400 словами', async () => {
    const bad = await GET(req('?days=90'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('days');
    expect(query).not.toHaveBeenCalled();
    await GET(req('?days=3&limit=5'));
    for (const [, params] of query.mock.calls) expect(params).toEqual([3, 5]);
  });

  it('тексты — только в шифре; открытого вопроса и ответа в теле нет; числа видны', async () => {
    const res = await GET(req('?days=7'));
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    for (const s of ['Авачинский', 'ветер до 20', 'Туров к вулканам', 'volcano', 'Анна', '914', 'guest@example.com']) {
      expect(raw).not.toContain(s);
    }
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, days: 7, web_sessions_read: 2, web_dialogs: 1, web_pairs: 1, a2a_read: 1, a2a_dialogs: 1, dropped_over_size: 0 });
    const batch = JSON.parse(open(body.sealed)) as ReviewBatch;
    expect(batch.web[0].pairs[0].q).toContain('Авачинский');
    expect(batch.web[0].pairs[0].q).not.toContain('Анна');
    expect(batch.a2a[0].pair.a).toContain('Туров к вулканам');
    expect(JSON.stringify(batch)).not.toMatch(/session_id|user_id/);
  });

  it('ключ не записан — 503 словами, базу не читает', async () => {
    keyState.pem = '   ';
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('ключ проверяющего не записан');
    expect(query).not.toHaveBeenCalled();
  });

  it('ключ не читается — 503, текстов в теле нет', async () => {
    keyState.pem = '-----BEGIN PUBLIC KEY-----\nбитый\n-----END PUBLIC KEY-----';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).toContain('не читается');
    expect(raw).not.toContain('Авачинский');
  });

  it('отказ базы — 502 с SQLSTATE; в логе нет текста диалогов', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('relation "chat_sessions" does not exist'), { code: '42P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, sqlstate: '42P01' });
    expect(err.mock.calls.flat().join(' ')).toContain('SQLSTATE=42P01');
  });
});

describe('объявления', () => {
  it('роут — ручной и без записи; его возможности — чтение и работа с ПД', () => {
    expect(DECLARED['kuzmich-review-batch']).toMatchObject({ kind: 'manual', writes: false });
    expect(MANUAL_ENDPOINTS).toHaveProperty('kuzmich-review-batch');
    expect(CRON_CAPABILITIES['kuzmich-review-batch']).toEqual(['db_read', 'pd_direct']);
  });
});
