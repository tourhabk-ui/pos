/**
 * Снимок до 20 МБ доходит до роута целиком (07.11).
 *
 * #3121 поднял предел снимка до 20 МБ, но middleware стоит на /api/*, и Next
 * держит копию тела для него с пределом experimental.middlewareClientMaxBodySize
 * (по умолчанию 10 МБ). Сверх предела роут молча получает только начало тела:
 * форма не разбирается, и снимок 15 МБ получал «Неверный формат запроса»
 * (замер на Next 15.5.27). Прокси Timeweb тело в 60 МБ пропустил — резал Next.
 *
 * Сторож гоняет копирование тела самого Next (next/dist/server/body-streams)
 * с пределом из next.config.js и разбирает то, что получил бы роут. Тело
 * больше предела — отказ словами про размер на каждом из пяти роутов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/storage/s3', () => ({ isS3Configured: true, uploadToS3: vi.fn(), deleteFromS3: vi.fn() }));
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: db.query }));
vi.mock('@/lib/auth/middleware', () => {
  const who = vi.fn(async () => ({ userId: 'u-1', role: 'operator' }));
  return { requireRole: who, requireOperator: who, requireAuth: who, requireAdmin: who };
});

import { UPLOAD_PHOTO_MAX_BYTES, PHOTO_TOO_LARGE } from '@/lib/images/upload-limits';
import { uploadBodyTooLarge } from '@/lib/images/upload-photo';
import { POST as tourPhoto } from '@/app/api/upload/tour-photo/route';
import { POST as operatorUpload } from '@/app/api/hub/operator/upload/route';
import { POST as reviewPhoto } from '@/app/api/reviews/photo/route';
import { POST as stayUpload } from '@/app/api/upload/route';
import { POST as partnerUpload } from '@/app/api/admin/content/partners/[id]/upload/route';

const require = createRequire(import.meta.url);

type Cloneable = { cloneBodyStream(): Readable; finalize(): Promise<void> };
const { getCloneableBody, requestToBodyStream } = require('next/dist/server/body-streams') as {
  getCloneableBody(readable: Readable, sizeLimit?: number): Cloneable;
  requestToBodyStream(ctx: { ReadableStream: typeof ReadableStream }, K: typeof Uint8Array, stream: Readable): ReadableStream<Uint8Array>;
};
const bytes = require('next/dist/compiled/bytes') as { parse(v: string): number };

/** Предел копии тела так, как его прочтёт Next: число или строка вида '21mb'. */
function configuredLimit(): number | undefined {
  const config = require('../../next.config.js') as { experimental?: { middlewareClientMaxBodySize?: number | string } };
  const v = config.experimental?.middlewareClientMaxBodySize;
  return typeof v === 'string' ? bytes.parse(v) : v;
}

/** Тело формы со снимком заданного размера — как его шлёт браузер. */
async function multipart(size: number): Promise<{ body: Buffer; contentType: string }> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(size)], 'phone.jpg', { type: 'image/jpeg' }));
  const res = new Response(fd);
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type')! };
}

/**
 * Путь тела в Next: копия для middleware, затем роут читает оставшуюся
 * половину (next-server: getCloneableBody → cloneBodyStream → finalize →
 * requestToBodyStream). Возвращает то, что разобрал бы роут.
 */
async function throughNext(body: Buffer, contentType: string, limit: number | undefined): Promise<FormData> {
  const chunks: Buffer[] = [];
  for (let i = 0; i < body.length; i += 64 * 1024) chunks.push(body.subarray(i, i + 64 * 1024));
  const incoming = Readable.from(chunks, { objectMode: false });
  const cloneable = getCloneableBody(incoming, limit);
  cloneable.cloneBodyStream().resume(); // middleware тело не читает — копия просто утекает
  await cloneable.finalize();
  const stream = requestToBodyStream({ ReadableStream }, Uint8Array, incoming);
  const req = new Request('http://localhost/api/upload/tour-photo', {
    method: 'POST', body: stream, headers: { 'content-type': contentType }, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return req.formData();
}

describe('копия тела в Next не обрезает снимок предельного размера', () => {
  it('предел next.config.js вмещает снимок в 20 МБ с обёрткой формы', async () => {
    const limit = configuredLimit();
    expect(limit, 'experimental.middlewareClientMaxBodySize не задан — Next режет на 10 МБ').toBeDefined();
    const { body, contentType } = await multipart(UPLOAD_PHOTO_MAX_BYTES);
    expect(body.length).toBeGreaterThan(UPLOAD_PHOTO_MAX_BYTES);

    const fd = await throughNext(body, contentType, limit);
    const file = fd.get('file');
    expect(file instanceof File && file.size).toBe(UPLOAD_PHOTO_MAX_BYTES);
  }, 60_000);

  it('с пределом Next по умолчанию тот же путь обрывает снимок в 15 МБ — так было до правки', async () => {
    const { body, contentType } = await multipart(15 * 1024 * 1024);
    await expect(throughNext(body, contentType, undefined)).rejects.toThrow();
  }, 60_000);
});

describe('тело больше предела — отказ словами про размер, а не «неверный формат»', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [{ id: 1, hero_image: null, logo_image: null }], rowCount: 1 });
  });

  /** Форма не разобралась, как у роута за обрезанной копией тела. */
  const cutBody = (contentLength: string | null) => ({
    formData: async () => { throw new TypeError('Failed to parse body as FormData.'); },
    headers: new Headers(contentLength === null ? {} : { 'content-length': contentLength }),
  }) as unknown as NextRequest;

  const routes: Array<[string, (r: NextRequest) => Promise<Response>]> = [
    ['/api/upload/tour-photo', (r) => tourPhoto(r)],
    ['/api/hub/operator/upload', (r) => operatorUpload(r)],
    ['/api/reviews/photo', (r) => reviewPhoto(r)],
    ['/api/upload', (r) => stayUpload(r)],
    ['/api/admin/content/partners/[id]/upload', (r) => partnerUpload(r, { params: Promise.resolve({ id: 'p-1' }) })],
  ];

  it.each(routes)('%s: 25 МБ — 413 и предел словами', async (_name, call) => {
    const res = await call(cutBody(String(25 * 1024 * 1024)));
    expect(res.status).toBe(413);
    const json = await res.json() as { error?: string };
    expect(json.error).toBe(PHOTO_TOO_LARGE);
  });

  it.each(routes)('%s: битая форма малого размера — прежний ответ 400 без слов про размер', async (_name, call) => {
    const res = await call(cutBody('1200'));
    expect(res.status).toBe(400);
    const json = await res.json() as { error?: string };
    expect(json.error).not.toBe(PHOTO_TOO_LARGE);
  });

  it('длины в заголовке нет — размер неизвестен, вывода о нём нет', () => {
    expect(uploadBodyTooLarge(cutBody(null))).toBe(false);
    expect(uploadBodyTooLarge(cutBody(''))).toBe(false);
    expect(uploadBodyTooLarge(cutBody('abc'))).toBe(false);
    expect(uploadBodyTooLarge(cutBody(String(UPLOAD_PHOTO_MAX_BYTES)))).toBe(false);
    expect(uploadBodyTooLarge(cutBody(String(UPLOAD_PHOTO_MAX_BYTES + 1)))).toBe(true);
  });
});
