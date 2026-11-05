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

vi.mock('@/lib/storage/s3', () => ({
  isS3Configured: true,
  s3PublicUrl: (key: string) => `https://s3.twcstorage.ru/bucket-x/${key}`,
  uploadToS3: vi.fn(async () => ({ url: 'x' })),
}));
vi.mock('@/lib/auth/middleware', () => ({ requireRole: vi.fn(async () => ({ userId: 'u-1', role: 'guide' })) }));

import { VideosField, MaterialsConsent, extrasBody } from '@/components/guide/OwnTourExtras';
import { OwnTourEditSchema } from '@/lib/guides/own-tour-edit';
import { POST as uploadVideo } from '@/app/api/upload/tour-video/route';
import { uploadToS3 } from '@/lib/storage/s3';
import { NextRequest } from 'next/server';

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

function uploadReq(file: Blob | null, poster: Blob | null): NextRequest {
  const form = new FormData();
  if (file) form.append('file', new File([file], 'a.mp4'));
  if (poster) form.append('poster', new File([poster], 'p.jpg'));
  return { formData: async () => form } as unknown as NextRequest;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('POST /api/upload/tour-video', () => {
  it('MP4 и JPEG по байтам — ключи videos/tours/<hash>, тип видео video/mp4', async () => {
    const res = await uploadVideo(uploadReq(new Blob([MP4]), new Blob([JPEG])));
    const json = await res.json() as { key: string; poster: string };
    expect(res.status).toBe(200);
    expect(json.key).toMatch(/^videos\/tours\/[0-9a-f]{12}\.mp4$/);
    expect(json.poster).toBe(json.key.replace('.mp4', '.jpg'));
    expect(vi.mocked(uploadToS3).mock.calls.map((c) => c[2])).toEqual(['video/mp4', 'image/jpeg']);
  });

  it('не MP4 по байтам, без обложки, обложка не JPEG — 400 словами, в хранилище ничего', async () => {
    expect((await uploadVideo(uploadReq(new Blob([JPEG]), new Blob([JPEG])))).status).toBe(400);
    expect((await uploadVideo(uploadReq(new Blob([MP4]), null))).status).toBe(400);
    const bad = await uploadVideo(uploadReq(new Blob([MP4]), new Blob([MP4])));
    expect((await bad.json() as { error: string }).error).toBe('Обложка — только JPEG');
    expect(uploadToS3).not.toHaveBeenCalled();
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

describe('форма: блок видео', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
      ok: true, key: 'videos/tours/aaa111.mp4', poster: 'videos/tours/aaa111.jpg', url: 'https://s/a.mp4', posterUrl: 'https://s/a.jpg',
    }) })));
  });

  it('добавить: кадр-обложка снимается, видео и обложка уходят одной загрузкой, клип в списке', async () => {
    const onChange = vi.fn();
    const grab = vi.fn(async () => new Blob([JPEG], { type: 'image/jpeg' }));
    render(<VideosField idBase="t" clips={[]} onChange={onChange} grabFrame={grab} />);
    fireEvent.change(screen.getByLabelText('Добавить видео'), { target: { files: [new File([MP4], 'Кратер Горелого.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toEqual([{ key: 'videos/tours/aaa111.mp4', poster: 'videos/tours/aaa111.jpg', url: 'https://s/a.mp4', posterUrl: 'https://s/a.jpg', label: 'Кратер Горелого' }]);
    const form = vi.mocked(fetch).mock.calls[0]![1]!.body as FormData;
    expect(form.get('file')).toBeInstanceOf(File);
    expect(form.get('poster')).toBeInstanceOf(Blob);
  });

  it('кадр не снялся — сказано словами, загрузки нет', async () => {
    render(<VideosField idBase="t" clips={[]} onChange={vi.fn()} grabFrame={async () => { throw new Error('видео не открылось в браузере'); }} />);
    fireEvent.change(screen.getByLabelText('Добавить видео'), { target: { files: [new File([MP4], 'x.mov')] } });
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
