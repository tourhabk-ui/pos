/**
 * lib/offline/outbox.ts — досыл офлайн-очередей поля (#2448).
 *
 * Две очереди копит человек на маршруте без связи: наблюдения с экрана
 * маршрута и полевые проверки (/field-check). Порядок у обеих один: сначала
 * запись (текст, вердикт), потом снимки к ней по одному. Здесь — сам досыл,
 * без React и без IndexedDB: хранилище и сеть подставляются, поэтому правило
 * проверяется вызовом (tests/unit/field-queues-outbox.test.ts).
 *
 * Что чинится (по коду до 14.10):
 *  - одна запись держала всю очередь: на ЛЮБОЙ неуспешный ответ проход
 *    останавливался, и запись, которую сервер не примет никогда (400 на
 *    форме), стояла первой навсегда, а всё за ней не уходило;
 *  - у наблюдения терялись снимки: не ушёл второй — запись всё равно
 *    удалялась вместе с третьим;
 *  - отказ уходил в `catch { break; }` без следа.
 *
 * Отказ делится по тому, от чего он зависит:
 *  - от СРЕДЫ: нет связи, 5xx, 429, 408, а ещё 401/403/404/405 — приёмник
 *    анонимный, такой ответ дал бы любой записи (шлюз, выкладка), а не этой.
 *    Запись ждёт, проход останавливается: следующая упрётся в то же самое;
 *  - от ЗАПИСИ: остальные 4xx (400 на форме, 413 на снимке, 422 на мате или
 *    координатах вне края). Повтор не поможет никогда: запись откладывается
 *    с причиной, её видит человек, очередь идёт дальше.
 * Отложенная запись остаётся на телефоне: решает человек — исправить,
 * отправить снова или удалить. Сама она больше не уходит.
 */

/** Почему сервер не принял запись или снимок к ней. */
export interface QueueRejection {
  /** Что не принято: сама запись или снимок к уже принятой записи. */
  part: 'record' | 'photo';
  /** Код ответа приёмника. */
  status: number;
  /** Слова сервера (`error` из ответа), иначе «код N». */
  reason: string;
  at: number;
}

/** Снимки, которые приёмник не принял: копятся, пока к записи едут остальные. */
export interface PhotoRefusal {
  status: number;
  reason: string;
  /** Сами снимки — на телефоне их может не быть больше нигде. */
  photos: string[];
}

/** Общее у записей обеих очередей. */
export interface OutboxRecord {
  id: string;
  /** Снимки, которые ещё надо довезти (base64 без префикса). */
  photos: string[];
  /** Отложена: сервер её не примет. null или нет поля — в очереди. */
  rejected?: QueueRejection | null;
  /** Отказы снимков, пока остальные снимки ещё в пути. */
  photoRefusal?: PhotoRefusal | null;
}

export type SendOutcome =
  | { kind: 'sent'; body: unknown }
  | { kind: 'retry'; status: number | null; reason: string }
  | { kind: 'rejected'; status: number; reason: string };

/**
 * 4xx, которые говорят о среде, а не о записи. Приёмники очередей анонимные:
 * 401/403/404/405 от них — шлюз или выкладка, и отложить по ним запись
 * значило бы отложить их все.
 */
const ENVIRONMENT_4XX: ReadonlySet<number> = new Set([401, 403, 404, 405, 408, 425, 429]);

/** true — сервер не примет ЭТУ запись никогда, сколько ни повторяй. */
export function isRecordRefusal(status: number): boolean {
  return status >= 400 && status < 500 && !ENVIRONMENT_4XX.has(status);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const REASON_MAX = 200;

function serverReason(body: unknown): string | null {
  if (!isObject(body) || typeof body.error !== 'string') return null;
  const text = body.error.trim();
  return text ? text.slice(0, REASON_MAX) : null;
}

/** POST JSON на приёмник очереди и исход по правилу выше. */
export async function postJson(
  url: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { kind: 'retry', status: null, reason: `нет связи: ${err instanceof Error ? err.message : String(err)}` };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    if (isObject(body) && body.success === true) return { kind: 'sent', body };
    // 200 не от нас: страница входа в Wi-Fi гостиницы или аэропорта отвечает
    // 200 на любой адрес. Запись не дошла — ждём настоящей сети.
    return { kind: 'retry', status: res.status, reason: 'ответ не от сервера Ведара' };
  }
  const reason = serverReason(body) ?? `код ${res.status}`;
  return isRecordRefusal(res.status)
    ? { kind: 'rejected', status: res.status, reason }
    : { kind: 'retry', status: res.status, reason };
}

export interface OutboxStore<T extends OutboxRecord> {
  /** В порядке постановки: улика не переставляется. */
  list(): Promise<T[]>;
  put(item: T): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface OutboxSpec<T extends OutboxRecord> {
  /** Имя очереди в логе: «наблюдения», «полевые проверки». */
  name: string;
  recordUrl: string;
  recordPayload(item: T): unknown;
  /** Номер записи из ответа приёмника; null — приёмник его не вернул. */
  recordId(body: unknown): string | null;
  photoUrl: string;
  photoPayload(recordId: string, photo: string): unknown;
  /** Номер уже принятой записи: текст ушёл в прошлый заход, снимки — нет. */
  sentId(item: T): string | null;
  withSentId(item: T, id: string): T;
}

export interface FlushResult {
  /** Ушли целиком в этот заход. */
  sent: number;
  /** Остались в очереди и уйдут сами. */
  waiting: number;
  /** Отложены: сервер их не примет, решает человек. */
  rejected: number;
}

type Post = (url: string, payload: unknown) => Promise<SendOutcome>;

function logRefusal(name: string, what: string, out: { status: number; reason: string }): void {
  // Только код и слова сервера: текст наблюдения и заметка проверки в лог не идут.
  console.error(`[очередь: ${name}] сервер не принял ${what}: код ${out.status}, ${out.reason}`);
}

function logRetry(name: string, out: { status: number | null; reason: string }): void {
  console.error(`[очередь: ${name}] досыл отложен до следующего захода: ${out.status === null ? '' : `код ${out.status}, `}${out.reason}`);
}

/**
 * Один проход по очереди. Отложенные записи не шлются. Отказ среды
 * останавливает проход — остальные ждут вместе с этой.
 */
export async function flushOutbox<T extends OutboxRecord>(
  spec: OutboxSpec<T>,
  store: OutboxStore<T>,
  post: Post = postJson,
  now: () => number = Date.now,
): Promise<FlushResult> {
  const queue = await store.list();
  const result: FlushResult = { sent: 0, waiting: 0, rejected: 0 };
  let stopped = false;

  for (const item of queue) {
    if (item.rejected) { result.rejected += 1; continue; }
    if (stopped) { result.waiting += 1; continue; }

    let current = item;
    let recordId = spec.sentId(item);
    if (!recordId) {
      const out = await post(spec.recordUrl, spec.recordPayload(item));
      if (out.kind === 'retry') {
        logRetry(spec.name, out);
        stopped = true;
        result.waiting += 1;
        continue;
      }
      if (out.kind === 'rejected') {
        logRefusal(spec.name, 'запись', out);
        await store.put({ ...item, rejected: { part: 'record', status: out.status, reason: out.reason, at: now() } });
        result.rejected += 1;
        continue;
      }
      recordId = spec.recordId(out.body);
      if (!recordId) {
        if (item.photos.length === 0) {
          await store.remove(item.id);
          result.sent += 1;
          continue;
        }
        // Запись принята, а номера нет — снимки привязать не к чему. Повтор
        // записи задвоил бы её, поэтому снимки откладываются для человека.
        const reason = 'сервер принял запись, но не вернул её номер — снимки привязать не к чему';
        logRefusal(spec.name, 'снимки', { status: 0, reason });
        await store.put({ ...item, rejected: { part: 'photo', status: 0, reason, at: now() } });
        result.rejected += 1;
        continue;
      }
      current = spec.withSentId(item, recordId);
    }

    // Снимки по одному. Не ушедший из-за среды ждёт следующего захода вместе
    // со всеми после него; не принятый сервером копится для человека.
    const left: string[] = [];
    let refusal: PhotoRefusal | null = current.photoRefusal ?? null;
    for (const photo of current.photos) {
      if (stopped) { left.push(photo); continue; }
      const out = await post(spec.photoUrl, spec.photoPayload(recordId, photo));
      if (out.kind === 'sent') continue;
      if (out.kind === 'retry') {
        logRetry(spec.name, out);
        stopped = true;
        left.push(photo);
        continue;
      }
      logRefusal(spec.name, 'снимок', out);
      refusal = {
        status: out.status,
        reason: out.reason,
        photos: [...(refusal?.photos ?? []), photo],
      };
    }

    if (left.length > 0) {
      // Запись принята, снимки — не все: держим её ради них, текст второй раз не шлём.
      await store.put({ ...current, photos: left, photoRefusal: refusal });
      result.waiting += 1;
      continue;
    }
    if (refusal) {
      await store.put({
        ...current,
        photos: refusal.photos,
        photoRefusal: null,
        rejected: { part: 'photo', status: refusal.status, reason: refusal.reason, at: now() },
      });
      result.rejected += 1;
      continue;
    }
    await store.remove(item.id);
    result.sent += 1;
  }
  return result;
}

/**
 * Очередь в памяти. Нужна, когда диска нет (приватный режим, переполненное
 * хранилище): запись шлётся сразу тем же правилом, и форма честно говорит,
 * ушла она, не принята или пропадёт. Тем же пользуются сторожа.
 */
export function memoryStore<T extends OutboxRecord>(
  initial: readonly T[] = [],
): OutboxStore<T> & { items(): T[] } {
  const map = new Map<string, T>(initial.map(i => [i.id, i]));
  return {
    async list() { return [...map.values()]; },
    async put(item) { map.set(item.id, item); },
    async remove(id) { map.delete(id); },
    items() { return [...map.values()]; },
  };
}

/** Сколько уйдёт само и сколько ждёт решения человека. */
export function queueCounts(items: readonly OutboxRecord[]): { waiting: number; rejected: number } {
  let rejected = 0;
  for (const item of items) if (item.rejected) rejected += 1;
  return { waiting: items.length - rejected, rejected };
}

/**
 * Проходы по одной очереди — строго по очереди. Досыл зовут старт приложения,
 * возврат сети, экран маршрута и форма; два прохода одновременно отправили
 * бы одну запись дважды. Следующий проход начинается после предыдущего и
 * читает очередь заново — отправленного в ней уже нет.
 */
export function serialized<R>(run: () => Promise<R>): () => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return () => {
    const next = tail.then(run);
    tail = next.catch(() => undefined);
    return next;
  };
}
