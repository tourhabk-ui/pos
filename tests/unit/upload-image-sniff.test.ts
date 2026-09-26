// @vitest-environment node
/**
 * POST /api/upload верит байтам, а не словам клиента.
 *
 * До 26.09 роут принимал всё, чей заявленный `File.type` начинался с
 * `image/` (включая image/svg+xml — документ со скриптами, отданный с
 * нашего хранилища), сохранял под расширением из имени файла, а
 * не-картинки молча пропускал и отвечал «успешно» с нулём файлов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const writeFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => {
  const m = {
    writeFile: (...a: unknown[]) => writeFileMock(...a),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
  return { ...m, default: m };
});
const uploadToS3Mock = vi.fn();
vi.mock('@/lib/storage/s3', () => ({
  isS3Configured: false,
  uploadToS3: (...a: unknown[]) => uploadToS3Mock(...a),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: vi.fn().mockResolvedValue({ userId: 'u', role: 'stay' }),
}));

import { POST as upload } from '@/app/api/upload/route';
import { sniffImage } from '@/lib/storage/image-sniff';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function uploadReq(files: File[]): NextRequest {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return new Request('http://localhost/api/upload', { method: 'POST', body: fd }) as unknown as NextRequest;
}

beforeEach(() => {
  writeFileMock.mockClear();
  uploadToS3Mock.mockReset();
});

describe('sniffImage', () => {
  it('JPEG/PNG/WebP по сигнатуре; SVG и текст — нет', () => {
    expect(sniffImage(JPG)?.ext).toBe('jpg');
    expect(sniffImage(PNG)?.ext).toBe('png');
    expect(sniffImage(WEBP)?.ext).toBe('webp');
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(new TextEncoder().encode('hello'))).toBeNull();
  });
});

describe('POST /api/upload', () => {
  it('SVG под видом PNG — 400, ничего не записано', async () => {
    const res = await upload(uploadReq([new File([SVG], 'photo.png', { type: 'image/png' })]));
    expect(res.status).toBe(400);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('заявленный image/svg+xml — 400', async () => {
    const res = await upload(uploadReq([new File([SVG], 'x.svg', { type: 'image/svg+xml' })]));
    expect(res.status).toBe(400);
  });

  it('не-картинка — отказ с именем файла, а не «успешно, 0 файлов»', async () => {
    const res = await upload(uploadReq([new File(['hello'], 'notes.jpg', { type: 'image/jpeg' })]));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('notes.jpg');
  });

  it('одна плохая в пачке — не пишется ни одна', async () => {
    const res = await upload(uploadReq([
      new File([PNG], 'a.png', { type: 'image/png' }),
      new File([SVG], 'b.png', { type: 'image/png' }),
    ]));
    expect(res.status).toBe(400);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('PNG с чужим именем и типом — расширение из байтов, а не из имени', async () => {
    const res = await upload(uploadReq([new File([PNG], 'evil.html', { type: 'text/html' })]));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { files: string[] } };
    expect(body.data.files).toHaveLength(1);
    expect(body.data.files[0]).toMatch(/^\/uploads\/[\w-]+\.png$/);
  });
});
