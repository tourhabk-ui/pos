// @vitest-environment jsdom
/**
 * Подписи под фото тура гид правит и после публикации (11.11).
 *
 * Гид Андрей Запорожец: «было бы неплохо редактировать подписи под фото после
 * публикации, а не только до». Поле «Чьи снимки» подписывало только фото без
 * подписи (writePhotoCredits) — однажды поставленную подпись поменять было
 * нечем. Теперь под каждым фото — своё поле подписи.
 *
 * Сторож — рендером формы, телом запроса и вызовом роута с подменённой базой.
 * Сам SQL записи проверен на PostgreSQL 16 при правке: поправленная подпись
 * заменяется, пустая снимается, снимок не этого тура и чужой тур — не
 * трогаются.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, written: true, tourPhotos: [] as string[] }));
vi.mock('@/lib/auth/middleware', () => ({ requireRole: vi.fn(async () => ({ userId: 'u-1', role: 'guide' })) }));
vi.mock('@/lib/auth/guide-helpers', () => ({ getGuidePartnerId: vi.fn(async () => '11111111-1111-1111-1111-111111111111') }));
vi.mock('@/lib/seo/indexnow', () => ({ pingTourChanged: vi.fn() }));
vi.mock('@/lib/tours/tour-write', () => ({
  writeTourPatch: vi.fn(async () => (db.written ? { outcome: 'written', row: { id: 70, title: 'Тур' } } : { outcome: 'not_found' })),
}));
vi.mock('@/lib/database', () => ({
  transaction: async <T,>(fn: (c: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<T>) => fn({
    query: async (sql: string, params: unknown[]) => {
      db.calls.push({ sql, params });
      if (/SELECT photos FROM operator_tours/.test(sql)) return { rows: [{ photos: db.tourPhotos }] };
      return { rows: [{ applied: 1 }] };
    },
  }),
}));

import { PhotosField, extrasBody } from '@/components/guide/OwnTourExtras';
import { OwnTourEditSchema, isStoredPhotoPath } from '@/lib/guides/own-tour-edit';
import { writeTourPatch } from '@/lib/tours/tour-write';
import { SET_PHOTO_CAPTIONS_SQL } from '@/lib/tours/editor-media';
import { PATCH } from '@/app/api/guide/own/tours/[id]/route';

afterEach(() => { cleanup(); db.calls = []; db.written = true; db.tourPhotos = []; });

const A = '/images/tours/a.jpg';
const B = '/images/tours/b.jpg';

describe('форма: подпись под каждым фото', () => {
  it('поле у каждого фото, с уже стоящей подписью; правка уходит наверх', () => {
    const onCaption = vi.fn();
    render(<PhotosField idBase="t" photos={[A, B]} onChange={vi.fn()} credits={{ [A]: 'Андрей Запорожец' }}
      credit="Андрей Запорожец" onCredit={vi.fn()} captions={{}} onCaption={onCaption} />);
    const first = screen.getAllByLabelText('Подпись: «Фото: …»')[0] as HTMLInputElement;
    expect(first.value).toBe('Андрей Запорожец');
    fireEvent.change(first, { target: { value: 'Андрей Запорожец, кратер Авачинского' } });
    expect(onCaption).toHaveBeenCalledWith(A, 'Андрей Запорожец, кратер Авачинского');
    // Второе фото без подписи — пусто, подсказка называет, что встанет.
    const second = screen.getAllByLabelText('Подпись: «Фото: …»')[1] as HTMLInputElement;
    expect(second.value).toBe('');
    expect(second.placeholder).toContain('Андрей Запорожец');
  });

  it('поправленная подпись показывается вместо записанной', () => {
    render(<PhotosField idBase="t" photos={[A]} onChange={vi.fn()} credits={{ [A]: 'Старая' }}
      captions={{ [A]: 'Новая' }} onCaption={vi.fn()} />);
    expect((screen.getByLabelText('Подпись: «Фото: …»') as HTMLInputElement).value).toBe('Новая');
  });
});

describe('тело запроса', () => {
  const base = { program: [], included: '', not_included: '', what_to_bring: '', safety_notes: '', video_clips: [], photo_credit: '' };
  it('только подписи фото этого тура, обрезанные; пустая — снять', () => {
    const body = extrasBody({ ...base, photos: [A], photo_captions: { [A]: '  Новая  ', [B]: 'убранное фото' } });
    expect(body.photo_captions).toEqual({ [A]: 'Новая' });
    expect(extrasBody({ ...base, photos: [A], photo_captions: { [A]: '' } }).photo_captions).toEqual({ [A]: '' });
    expect(OwnTourEditSchema.safeParse(body).success).toBe(true);
  });
  it('не правили — поля нет', () => {
    expect(extrasBody({ ...base, photos: [A] })).not.toHaveProperty('photo_captions');
  });
  it('подпись длиннее 120 знаков — отказ схемы', () => {
    expect(OwnTourEditSchema.safeParse({ photo_captions: { [A]: 'я'.repeat(121) } }).success).toBe(false);
  });
});

describe('роут правки: подписи пишутся после записи тура', () => {
  const patch = (body: unknown) => PATCH(
    new NextRequest('http://x/api/guide/own/tours/70', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ id: '70' }) },
  );

  it('подписи уходят в запись с этим туром и этим гидом', async () => {
    const res = await patch({ photos: [A], photo_captions: { [A]: 'Новая', [B]: '' } });
    expect(res.status).toBe(200);
    const call = db.calls.find((c) => c.sql === SET_PHOTO_CAPTIONS_SQL);
    expect(call?.params).toEqual(['11111111-1111-1111-1111-111111111111', '70', JSON.stringify({ [A]: 'Новая', [B]: '' })]);
  });

  it('тур не найден среди своих — подписи не пишутся', async () => {
    db.written = false;
    const res = await patch({ photos: [A], photo_captions: { [A]: 'Новая' } });
    expect(res.status).toBe(404);
    expect(db.calls.some((c) => c.sql === SET_PHOTO_CAPTIONS_SQL)).toBe(false);
  });

  it('SQL пишет только снимки этого тура этого гида', () => {
    expect(SET_PHOTO_CAPTIONS_SQL).toMatch(/WHERE t\.id = \$2::bigint AND t\.operator_id = \$1::uuid AND t\.deleted_at IS NULL/);
    expect(SET_PHOTO_CAPTIONS_SQL).toMatch(/JOIN tp ON tp\.u = k\b/);
    expect(SET_PHOTO_CAPTIONS_SQL).toMatch(/WHERE id = \$1::uuid/);
  });
});

describe('снимки, перенесённые миграцией 1406, не роняют правку тура (11.11)', () => {
  const MOVED = '/api/images/s3/photos/zaporozhets/gorely-crater-lake.jpg';
  const OTHER = '/api/images/s3/photos/laguna/bus.jpg';
  const patch = (body: unknown) => PATCH(
    new NextRequest('http://x/api/guide/own/tours/70', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ id: '70' }) },
  );

  it('адрес раздачи хранилища узнаётся; не снимок и «..» — нет', () => {
    expect(isStoredPhotoPath(MOVED)).toBe(true);
    expect(isStoredPhotoPath('/api/images/s3/places/x.jpg')).toBe(false);
    expect(isStoredPhotoPath('/api/images/s3/photos/../x.jpg')).toBe(false);
    expect(isStoredPhotoPath('https://evil.example/photos/x.jpg')).toBe(false);
    expect(OwnTourEditSchema.safeParse({ photos: [MOVED] }).success).toBe(true);
  });

  it('снимок уже стоит у тура — правка с подписью записывается', async () => {
    db.tourPhotos = [MOVED];
    const res = await patch({ photos: [MOVED], photo_captions: { [MOVED]: 'Андрей Запорожец' } });
    expect(res.status).toBe(200);
    expect(db.calls.some((c) => c.sql === SET_PHOTO_CAPTIONS_SQL)).toBe(true);
  });

  it('чужой снимок из хранилища — 400, тур не тронут', async () => {
    db.tourPhotos = [MOVED];
    vi.mocked(writeTourPatch).mockClear();
    const res = await patch({ photos: [MOVED, OTHER] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/уже стоящее у этого тура/);
    expect(writeTourPatch).not.toHaveBeenCalled();
    expect(db.calls.some((c) => c.sql === SET_PHOTO_CAPTIONS_SQL)).toBe(false);
  });

  it('свежая загрузка гида базу не спрашивает', async () => {
    await patch({ photos: [A] });
    expect(db.calls.some((c) => /SELECT photos FROM operator_tours/.test(c.sql))).toBe(false);
  });
});
