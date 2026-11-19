/**
 * lib/agents/review/review-batch.ts — диалоги Кузьмича для оценки человеком
 * или сессией вместо судьи-модели (слово владельца 19.11 «у судьи баланса нет
 * возьми на себя его работу пока»).
 *
 * Судья (`lib/agents/managed/kuzmich-outcomes`) оценивает ответ в момент
 * ответа и текст не хранит. Неделя 10–16.11 прошла с 40 попытками оценки и
 * без единой записи (#3179): оценивать было некому. Оценить можно только то,
 * что лежит в базе: веб-чат (`chat_sessions`, последние 20 реплик сессии) и
 * журнал A2A (`a2a_dialogs`, 90 суток). Telegram и MAX разговоров не хранят.
 *
 * Что уходит наружу и что нет:
 *  · вопрос и ответ — через `redactChatPD`: телефон, почта, ссылки, ники,
 *    имя, которым человек представился, и подпись. Это больше, чем видел
 *    судья (`redactPII` — только телефон и почта). Имя вне этих оборотов и то,
 *    что человек написал о себе (здоровье, где ночует), маска не узнаёт;
 *  · тексты — только шифром (`sealForReviewer`): AES-256-GCM, ключ закрыт
 *    RSA-OAEP-SHA256 открытым ключом проверяющего из кода. Открытого текста
 *    в ответе нет ни при каком параметре;
 *  · id сессии, user_id, адрес и агент A2A целиком не уходят: у веб-диалога —
 *    день и роль чата, у A2A — день и самоназвание программы.
 *
 * Сторож: tests/unit/kuzmich-review-batch.test.ts.
 */
import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { redactChatPD } from '@/lib/security/pii-redact';

export const QUESTION_MAX = 1500;
export const ANSWER_MAX = 4000;
/**
 * Потолок открытого текста выгрузки. Шифр в base64 длиннее на треть, а лог
 * проверки прода печатает тело до 256 КБ: 150 КБ открытого текста оставляют
 * запас, чтобы шифр не обрезался посреди и не стал нечитаемым целиком.
 */
export const PLAIN_MAX_BYTES = 150_000;

export interface ReviewPair {
  q: string;
  a: string;
}

export interface WebDialog {
  /** День последней реплики сессии по Камчатке; у реплик своего времени нет. */
  day: string;
  /** Роль чата: tourist, operator, guide… */
  role: string;
  pairs: ReviewPair[];
}

export interface A2aDialog {
  day: string;
  agent: string;
  self: boolean;
  pair: ReviewPair;
}

export interface ReviewBatch {
  web: WebDialog[];
  a2a: A2aDialog[];
  /** Сколько диалогов не вошло из-за потолка размера — не молча. */
  dropped: number;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

function textOf(m: unknown): { role: string; content: string } | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (typeof o.role !== 'string' || typeof o.content !== 'string') return null;
  return { role: o.role, content: o.content };
}

/**
 * Пары «вопрос человека — следующий ответ Кузьмича» из реплик сессии. Реплика
 * без ответа и ответ без вопроса в пару не идут: оценивать нечего.
 */
export function pairsFromMessages(messages: unknown): ReviewPair[] {
  if (!Array.isArray(messages)) return [];
  const turns = messages.map(textOf);
  const out: ReviewPair[] = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const cur = turns[i];
    if (!prev || !cur || prev.role !== 'user' || cur.role !== 'assistant') continue;
    const q = redactChatPD(prev.content).trim();
    const a = redactChatPD(cur.content).trim();
    if (!q || !a) continue;
    out.push({ q: clip(q, QUESTION_MAX), a: clip(a, ANSWER_MAX) });
  }
  return out;
}

export interface WebRow { day: string; role: string | null; messages: unknown }
export interface A2aRow { day: string; agent: string; is_self: boolean; question: string; answer: string }

/**
 * Выгрузка из строк базы: маска, пары, потолок размера. Порядок — как пришли
 * строки (свежие первыми); не вошедшее по размеру считается в `dropped`.
 */
export function buildReviewBatch(webRows: readonly WebRow[], a2aRows: readonly A2aRow[], plainMax = PLAIN_MAX_BYTES): ReviewBatch {
  const batch: ReviewBatch = { web: [], a2a: [], dropped: 0 };
  let size = 2;
  const fits = (item: unknown): boolean => {
    const len = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (size + len > plainMax) return false;
    size += len;
    return true;
  };
  for (const r of webRows) {
    const pairs = pairsFromMessages(r.messages);
    if (pairs.length === 0) continue;
    const item: WebDialog = { day: r.day, role: r.role ?? 'не записана', pairs };
    if (fits(item)) batch.web.push(item); else batch.dropped++;
  }
  for (const r of a2aRows) {
    const q = redactChatPD(r.question).trim();
    const a = redactChatPD(r.answer).trim();
    if (!q || !a) continue;
    const item: A2aDialog = { day: r.day, agent: r.agent, self: r.is_self, pair: { q: clip(q, QUESTION_MAX), a: clip(a, ANSWER_MAX) } };
    if (fits(item)) batch.a2a.push(item); else batch.dropped++;
  }
  return batch;
}

export interface SealedBatch {
  alg: 'RSA-OAEP-256+A256GCM';
  key_fingerprint: string;
  wrapped_key: string;
  iv: string;
  tag: string;
  ct: string;
}

/** Отпечаток открытого ключа: первые 16 знаков sha256 от DER. */
export function keyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Шифр для проверяющего. Ключ не читается — исключение: вызывающий отвечает
 * отказом, а не открытым текстом.
 */
export function sealForReviewer(plain: string, publicKeyPem: string): SealedBatch {
  const pub = createPublicKey(publicKeyPem);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return {
    alg: 'RSA-OAEP-256+A256GCM',
    key_fingerprint: keyFingerprint(publicKeyPem),
    wrapped_key: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}
