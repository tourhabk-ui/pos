// @vitest-environment jsdom
/**
 * Видео тура, подпись «Фото: …» и согласие на показ — у гида на сайте (05.11,
 * слово владельца «да делай»).
 *
 * До этого дня клип тура появлялся только миграцией, подписи снимков писала
 * только миграция, а согласие на материалы (§0, 1321) открывал лишь менеджер.
 * Сторож: загрузка видео проверяет байты и требует обложку; клипы и подпись
 * уходят правкой тура; уже стоящий клип миграции правку не роняет; подпись —
 * снимкам без подписи; кнопка согласия открывает страницу подписи или
 * называет дату.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const s3 = vi.hoisted(() => ({
  presign: vi.fn(async (key: string, type: string, size: number) => `https://s3.twcstorage.ru/bucket-x/${key}?sig=1&type=${type}&size=${size}`),
  head: vi.fn(),
}));
vi.mock('@/lib/storage/s3', () => ({
  isS3Configured: true,
  s3PublicUrl: (key: string) => `https://s3.twcstorage.ru/bucket-x/${key}`,
  presignPutUrl: s3.presign,
  headObjectInfo: s3.head,
}));
vi.mock('@/lib/auth/middleware', () => ({ requireRole: vi.fn(async () => ({ userId: 'u-1', role: 'guide' })) }));

import { VideosField, MaterialsConsent, extrasBody } from '@/components/guide/OwnTourExtras';
import { OwnTourEditSchema } from '@/lib/guides/own-tour-edit';
import { POST as uploadVideo } from '@/app/api/upload/tour-video/route';
import { POST as confirmVideo } from '@/app/api/upload/tour-video/confirm/route';
import { NextRequest } from 'next/server';

const MB = 1024 * 1024;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('видео — из браузера прямо в хранилище', () => {
  it('подпись: ключи videos/tours/<12>, ссылки на запись с типом и размером; байты через сервер не идут', async () => {
    const res = await uploadVideo(jsonReq({ videoSize: 120 * MB, posterSize: 40_000 }));
    const json = await res.json() as Record<string, string>;
    expect(res.status).toBe(200);
    expect(json.key).toMatch(/^videos\/tours\/[a-z0-9]{12}\.mp4$/);
    expect(json.poster).toBe(json.key.replace('.mp4', '.jpg'));
    expect(s3.presign.mock.calls).toEqual([[json.key, 'video/mp4', 120 * MB], [json.poster, 'image/jpeg', 40_000]]);
  });

  it('больше 500 МБ или без размеров — 400 словами, ссылок нет', async () => {
    const big = await uploadVideo(jsonReq({ videoSize: 501 * MB, posterSize: 1000 }));
    expect(big.status).toBe(400);
    expect((await big.json() as { error: string }).error).toBe('Видео больше 500 МБ — укоротите ролик');
    expect((await uploadVideo(jsonReq({}))).status).toBe(400);
    expect(s3.presign).not.toHaveBeenCalled();
  });

  it('проверка: объект на месте и того типа — да; не дошёл или не тот тип — 409 словами', async () => {
    const keys = { key: 'videos/tours/abcdefabcdef.mp4', poster: 'videos/tours/abcdefabcdef.jpg' };
    s3.head.mockImplementation(async (k: string) => (k.endsWith('.mp4') ? { size: 5 * MB, contentType: 'video/mp4' } : { size: 30_000, contentType: 'image/jpeg' }));
    expect((await confirmVideo(jsonReq(keys))).status).toBe(200);
    s3.head.mockImplementation(async (k: string) => (k.endsWith('.mp4') ? null : { size: 30_000, contentType: 'image/jpeg' }));
    const lost = await confirmVideo(jsonReq(keys));
    expect(lost.status).toBe(409);
    expect((await lost.json() as { error: string }).error).toBe('Видео в хранилище не дошло — загрузите ещё раз');
    s3.head.mockImplementation(async () => ({ size: 10, contentType: 'text/html' }));
    expect((await confirmVideo(jsonReq(keys))).status).toBe(409);
    expect((await confirmVideo(jsonReq({ key: 'videos/../x.mp4', poster: keys.poster }))).status).toBe(400);
  });

  it('хранилище не ответило на проверку — 503 «не проверить», а не «загружено»', async () => {
    s3.head.mockRejectedValue(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await confirmVideo(jsonReq({ key: 'videos/tours/abcdefabcdef.mp4', poster: 'videos/tours/abcdefabcdef.jpg' }));
    expect(r.status).toBe(503);
  });
});

describe('схема правки: клипы и подпись', () => {
  const clip = { key: 'videos/tours/abc123.mp4', poster: 'videos/tours/abc123.jpg', label: 'Кратер' };

  it('клип загрузки и клип миграции (videos/<гид>/…) — да; чужой путь и «..» — нет', () => {
    expect(OwnTourEditSchema.safeParse({ video_clips: [clip] }).success).toBe(true);
    expect(OwnTourEditSchema.safeParse({ video_clips: [{ key: 'videos/zaporozhets/kurile-1.mp4', poster: 'videos/zaporozhets/kurile-1.jpg', label: 'x' }] }).success).toBe(true);
    expect(OwnTourEditSchema.safeParse({ video_clips: [{ ...clip, key: 'images/x.mp4' }] }).success).toBe(false);
    expect(OwnTourEditSchema.safeParse({ video_clips: [{ ...clip, key: 'videos/../x.mp4' }] }).success).toBe(false);
    expect(OwnTourEditSchema.safeParse({ video_clips: Array(7).fill(clip) }).success).toBe(false);
  });

  it('тело формы: клипы без адресов превью, подпись — только когда есть фото', () => {
    const base = { program: [], included: '', not_included: '', what_to_bring: '', safety_notes: '', photos: [] as string[] };
    const withClip = extrasBody({ ...base, video_clips: [{ ...clip, url: 'https://x/a.mp4', posterUrl: 'https://x/a.jpg' }], photo_credit: 'Андрей Запорожец' });
    expect(withClip.video_clips).toEqual([clip]);
    expect(withClip).not.toHaveProperty('photo_credit');
    const withPhoto = extrasBody({ ...base, photos: ['/images/tours/a.jpg'], video_clips: [], photo_credit: 'Андрей Запорожец' });
    expect(withPhoto.photo_credit).toBe('Андрей Запорожец');
    expect(OwnTourEditSchema.safeParse(withPhoto).success).toBe(true);
  });
});

class FakeXhr {
  static sent: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  static status = 200;
  url = ''; headers: Record<string, string> = {}; status = 0;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: unknown) {
    FakeXhr.sent.push({ url: this.url, headers: this.headers, body });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    this.status = FakeXhr.status;
    setTimeout(() => this.onload?.(), 0);
  }
}

describe('форма: блок видео', () => {
  beforeEach(() => {
    FakeXhr.sent = [];
    FakeXhr.status = 200;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url === '/api/upload/tour-video'
        ? { ok: true, key: 'videos/tours/aaa111aaa111.mp4', poster: 'videos/tours/aaa111aaa111.jpg', uploadUrl: 'https://s3/put-video', posterUploadUrl: 'https://s3/put-poster', url: 'https://s/a.mp4', posterUrl: 'https://s/a.jpg' }
        : { ok: true }),
    })));
  });

  it('добавить: обложка снимается, ролик и обложка пишутся прямо в хранилище, сервер проверяет — клип в списке', async () => {
    const onChange = vi.fn();
    const grab = vi.fn(async () => new Blob([JPEG], { type: 'image/jpeg' }));
    const file = new File([new Uint8Array(64)], 'Кратер Горелого.mp4', { type: 'video/mp4' });
    render(<VideosField idBase="t" clips={[]} onChange={onChange} grabFrame={grab} />);
    fireEvent.change(screen.getByLabelText('Добавить видео'), { target: { files: [file] } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toEqual([{ key: 'videos/tours/aaa111aaa111.mp4', poster: 'videos/tours/aaa111aaa111.jpg', url: 'https://s/a.mp4', posterUrl: 'https://s/a.jpg', label: 'Кратер Горелого' }]);
    expect(FakeXhr.sent.map((x) => [x.url, x.headers['Content-Type'], x.headers['Cache-Control']])).toEqual([
      ['https://s3/put-video', 'video/mp4', 'public, max-age=31536000, immutable'],
      ['https://s3/put-poster', 'image/jpeg', 'public, max-age=31536000, immutable'],
    ]);
    expect(FakeXhr.sent[0]!.body).toBe(file);
    const calls = vi.mocked(fetch).mock.calls.map((c) => [c[0], JSON.parse(String((c[1] as RequestInit).body))]);
    expect(calls).toEqual([
      ['/api/upload/tour-video', { videoSize: 64, posterSize: JPEG.length }],
      ['/api/upload/tour-video/confirm', { key: 'videos/tours/aaa111aaa111.mp4', poster: 'videos/tours/aaa111aaa111.jpg' }],
    ]);
  });

  it('хранилище не приняло ролик — сказано, проверки и клипа нет', async () => {
    FakeXhr.status = 403;
    const onChange = vi.fn();
    render(<VideosField idBase="t" clips={[]} onChange={onChange} grabFrame={async () => new Blob([JPEG])} />);
    fireEvent.change(screen.getByLabelText('Добавить видео'), { target: { files: [new File([new Uint8Array(8)], 'a.mp4')] } });
    expect(await screen.findByText('a.mp4: хранилище не приняло видео — попробуйте ещё раз')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual(['/api/upload/tour-video']);
  });

  it('кадр не снялся — сказано словами, ничего не подписано', async () => {
    render(<VideosField idBase="t" clips={[]} onChange={vi.fn()} grabFrame={async () => { throw new Error('видео не открылось в браузере'); }} />);
    fireEvent.change(screen.getByLabelText('Добавить видео'), { target: { files: [new File([new Uint8Array(8)], 'x.mov')] } });
    expect(await screen.findByText(/x\.mov: обложку не снять \(видео не открылось в браузере\)/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('форма: согласие на показ', () => {
  it('подписано — дата; не подписано — открывается страница подписи', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, signedOn: '2026-11-05' }) })));
    render(<MaterialsConsent />);
    fireEvent.click(screen.getByRole('button', { name: /Согласие на показ фото и видео/ }));
    expect(await screen.findByText('Согласие подписано 05.11.2026 — подписывать снова не нужно.')).toBeTruthy();
    cleanup();

    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, url: 'https://vedarai.ru/partner-consent#k' }) })));
    render(<MaterialsConsent />);
    fireEvent.click(screen.getByRole('button', { name: /Согласие на показ фото и видео/ }));
    await screen.findByText(/Открылась страница подписи/);
    expect(open).toHaveBeenCalledWith('https://vedarai.ru/partner-consent#k', '_blank', 'noopener');
  });
});
