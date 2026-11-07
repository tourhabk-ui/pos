/**
 * Формы загрузки снимков: файл больше предела не уходит на сервер, фото
 * жилья уходят по одному файлу на запрос (07.11).
 *
 * Тело запроса к /api/* держится в пределе одного снимка (next.config.js,
 * middlewareClientMaxBodySize, сторож tests/unit/upload-body-limit.test.ts).
 * Пачка из нескольких снимков жилья его перерастала, а снимок больше 20 МБ
 * гнался по мобильной связи ради отказа. Формы гида, туриста, оператора и
 * жилья говорят про размер до отправки — одной строкой с сервером.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/storage/s3', () => ({
  s3PublicUrl: (key: string) => `https://s3.twcstorage.ru/bucket-x/${key}`,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { PHOTO_TOO_LARGE, UPLOAD_PHOTO_MAX_BYTES } from '@/lib/images/upload-limits';
import PhotosClient from '@/app/hub/stay/accommodations/[id]/photos/_PhotosClient';
import { OwnTourForm } from '@/components/guide/OwnToursManager';
import TourReviewForm from '@/components/marketplace/TourReviewForm';
import { TourForm } from '@/components/operator/Tours/TourForm';
import type { OwnTour } from '@/lib/guides/own-tours';

/** Файл с размером больше предела — без 21 МБ в памяти: размер подставлен. */
function huge(name = 'huge.jpg'): File {
  const f = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(f, 'size', { value: UPLOAD_PHOTO_MAX_BYTES + 1 });
  return f;
}
const small = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

const S3 = 'https://s3.twcstorage.ru/bucket-x/images/tours/';
let fetchMock: ReturnType<typeof vi.fn>;
const posted = (url: string) => fetchMock.mock.calls.filter((c) => c[0] === url);

beforeEach(() => {
  let n = 0;
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/upload') {
      n += 1;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { files: [`https://s3.twcstorage.ru/b/uploads/${n}.jpg`], count: 1 } }) };
    }
    if (url === '/api/upload/tour-photo') return { ok: true, status: 200, json: async () => ({ ok: true, url: `${S3}tour_new.jpg` }) };
    if (url === '/api/reviews/photo') return { ok: true, status: 200, json: async () => ({ ok: true, url: `${S3}review.jpg` }) };
    if (url === '/api/hub/operator/upload') return { ok: true, status: 200, json: async () => ({ success: true, url: `${S3}op.jpg` }) };
    if (String(url).includes('/photos')) return { ok: true, status: 200, json: async () => ({ success: true, data: { photos: [] } }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('фото жилья', () => {
  it('каждый файл — своим запросом; большой не отправлен и назван по имени', async () => {
    const { container } = render(<PhotosClient accommodationId="acc-1" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [small('a.jpg'), huge(), small('b.jpg')] } });

    await waitFor(() => expect(posted('/api/upload')).toHaveLength(2));
    for (const [, init] of posted('/api/upload')) {
      const fd = (init as RequestInit).body as FormData;
      expect(fd.getAll('files')).toHaveLength(1);
    }
    const sent = posted('/api/upload').map(([, init]) => ((init as RequestInit).body as FormData).get('files') as File);
    expect(sent.map((f) => f.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(await screen.findByText(new RegExp(`«huge\\.jpg»: ${PHOTO_TOO_LARGE.slice(0, 20)}`))).toBeTruthy();
    // Оба малых привязаны к объекту.
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/stay/accommodations/acc-1/photos' && (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(2));
  });
});

describe('фото тура в форме гида', () => {
  const TOUR: OwnTour = {
    id: '77', title: 'Вачкажец + озёрки', slug: null, is_published: false, is_active: true,
    base_price: '12000', price_unit: 'per_person', max_participants: 8,
    short_description: null, description: 'Однодневный поход.',
    program: null, included: null, not_included: null, what_to_bring: null, safety_notes: null,
    photos: [], season_start: null, season_end: null, open_dates: 0, on_storefront: false, blockers: [],
  };

  it('больше предела — отказ до отправки, малый уходит', async () => {
    render(<OwnTourForm tour={TOUR} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Добавить фото'), { target: { files: [huge(), small('ok.jpg')] } });
    expect(await screen.findByText(new RegExp(`huge\\.jpg: ${PHOTO_TOO_LARGE.slice(0, 20)}`))).toBeTruthy();
    const sent = posted('/api/upload/tour-photo').map(([, init]) => ((init as RequestInit).body as FormData).get('file') as File);
    expect(sent.map((f) => f.name)).toEqual(['ok.jpg']);
  });
});

describe('фото к отзыву туриста', () => {
  it('больше предела — отказ словами, запроса нет', async () => {
    const { container } = render(<TourReviewForm tourId={5} />);
    fireEvent.click(screen.getByRole('button', { name: /Оставить отзыв/ }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [huge()] } });
    expect(await screen.findByText(PHOTO_TOO_LARGE)).toBeTruthy();
    expect(posted('/api/reviews/photo')).toHaveLength(0);
  });
});

describe('фото тура в форме оператора', () => {
  it('больше предела — отказ словами, запроса нет', async () => {
    const { container } = render(<TourForm onSubmit={async () => undefined} onCancel={() => undefined} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [huge()] } });
    expect(await screen.findByText(PHOTO_TOO_LARGE)).toBeTruthy();
    expect(posted('/api/hub/operator/upload')).toHaveLength(0);
  });
});
