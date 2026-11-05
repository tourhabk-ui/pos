// @vitest-environment jsdom
/**
 * Программа, списки и фото своего тура — в форме гида на сайте (05.11).
 *
 * Гид Андрей Запорожец: «непонятно, как отредактировать программу маршрута
 * или добавить фото видео к туру (в первую очередь нужно)». Форма правила
 * шесть полей, а программу, списки и фото сервер отвергал (`.strict()`).
 *
 * Сторож держит: форма показывает записанное, правка уходит в PATCH теми
 * полями; пустой список уходит null; фото грузятся через загрузку тура, первое
 * — главное; сервер принимает только адреса, выданные загрузкой.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/storage/s3', () => ({
  s3PublicUrl: (key: string) => `https://s3.twcstorage.ru/bucket-x/${key}`,
}));

import { OwnTourForm } from '@/components/guide/OwnToursManager';
import { extrasBody } from '@/components/guide/OwnTourExtras';
import { OwnTourEditSchema, isOwnTourPhotoUrl } from '@/lib/guides/own-tour-edit';
import type { OwnTour } from '@/lib/guides/own-tours';

const S3 = 'https://s3.twcstorage.ru/bucket-x/images/tours/';

const TOUR: OwnTour = {
  id: '77', title: 'Вачкажец + озёрки', slug: null, is_published: false, is_active: true,
  base_price: '12000', price_unit: 'per_person', max_participants: 8,
  short_description: null, description: 'Однодневный поход к озёрам Вачкажца.',
  program: [{ title: 'Дорога', text: 'Выезд в 7:00' }],
  included: ['Трансфер'], not_included: null, what_to_bring: ['Ботинки', 'Куртка'], safety_notes: null,
  photos: [`${S3}tour_aaa.jpg`],
  season_start: null, season_end: null, open_dates: 0, on_storefront: false, blockers: [],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/upload/tour-photo') {
      return { ok: true, status: 200, json: async () => ({ ok: true, url: `${S3}tour_bbb.jpg` }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function patchBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/guide/own/tours/77'));
  expect(call, 'PATCH не ушёл').toBeDefined();
  expect((call![1] as RequestInit).method).toBe('PATCH');
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

describe('форма правки своего тура: программа, списки, фото', () => {
  it('показывает записанное: шаг программы, списки по строкам, главное фото', () => {
    render(<OwnTourForm tour={TOUR} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByLabelText('Шаг 1 — название') as HTMLInputElement).value).toBe('Дорога');
    expect((screen.getByLabelText(/Что взять с собой/) as HTMLTextAreaElement).value).toBe('Ботинки\nКуртка');
    expect(screen.getByAltText('Главное фото тура').getAttribute('src')).toBe(`${S3}tour_aaa.jpg`);
  });

  it('добавить шаг, поправить список, загрузить фото и сделать его главным — всё уходит одним PATCH', async () => {
    const onDone = vi.fn();
    render(<OwnTourForm tour={TOUR} onDone={onDone} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Добавить шаг/ }));
    fireEvent.change(screen.getByLabelText('Шаг 2 — название'), { target: { value: 'Озёра' } });
    fireEvent.change(screen.getByLabelText('Шаг 2 — что происходит'), { target: { value: 'Купание, обед' } });
    fireEvent.change(screen.getByLabelText(/Что не входит в цену/), { target: { value: 'Питание\n\nСтраховка\n' } });
    fireEvent.change(screen.getByLabelText(/Что включено/), { target: { value: '' } });

    const file = new File(['x'], 'ozero.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Добавить фото'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByAltText('Фото тура 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Сделать главным' }));

    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const body = patchBody();
    expect(body.program).toEqual([{ title: 'Дорога', text: 'Выезд в 7:00' }, { title: 'Озёра', text: 'Купание, обед' }]);
    expect(body.not_included).toEqual(['Питание', 'Страховка']);
    expect(body.included).toBeNull();
    expect(body.what_to_bring).toEqual(['Ботинки', 'Куртка']);
    expect(body.photos).toEqual([`${S3}tour_bbb.jpg`, `${S3}tour_aaa.jpg`]);
    // Сервер такое тело принимает.
    expect(OwnTourEditSchema.safeParse(body).success).toBe(true);
  });

  it('шаг без названия, но с текстом — сказано словами, кнопка не отправляет', () => {
    render(<OwnTourForm tour={TOUR} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Шаг 1 — название'), { target: { value: '' } });
    expect(screen.getByTestId('own-tour-gaps').textContent).toMatch(/у шага программы 1 нет названия/);
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отказ загрузки назван словами сервера, фото не добавлено', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Файл слишком большой (макс. 20 МБ)' }) }));
    render(<OwnTourForm tour={TOUR} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Добавить фото'), { target: { files: [new File(['x'], 'big.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText(/big\.jpg: Файл слишком большой/)).toBeTruthy();
    expect(screen.queryByAltText('Фото тура 2')).toBeNull();
  });

  it('сезон правится формой: 1–14.07 перестанут быть «вне сезона»', async () => {
    const onDone = vi.fn();
    render(<OwnTourForm tour={{ ...TOUR, season_start: '2027-07-15', season_end: '2027-10-15' }} onDone={onDone} onCancel={vi.fn()} />);
    expect((screen.getByLabelText('С') as HTMLInputElement).value).toBe('2027-07-15');
    fireEvent.change(screen.getByLabelText('С'), { target: { value: '2027-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const body = patchBody();
    expect(body).toMatchObject({ season_start: '2027-07-01', season_end: '2027-10-15' });
    expect(OwnTourEditSchema.safeParse(body).success).toBe(true);
  });

  it('сезон наоборот — сказано словами, сервер тоже не примет', () => {
    render(<OwnTourForm tour={{ ...TOUR, season_start: '2027-07-15', season_end: '2027-10-15' }} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('С'), { target: { value: '2027-11-01' } });
    expect(screen.getByTestId('own-tour-gaps').textContent).toMatch(/сезон кончается раньше, чем начинается/);
    expect(OwnTourEditSchema.safeParse({ season_start: '2027-11-01', season_end: '2027-10-15' }).success).toBe(false);
  });

  it('новый тур — без этих полей, с подсказкой «Править» после создания', () => {
    render(<OwnTourForm onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('Добавить фото')).toBeNull();
    expect(screen.getByText(/добавите кнопкой «Править» после создания черновика/)).toBeTruthy();
  });
});

describe('сервер: какие фото и поля принимает правка гида', () => {
  it('адреса загрузки — да, чужой сайт и выход из каталога — нет', () => {
    expect(isOwnTourPhotoUrl(`${S3}tour_abc123.jpg`)).toBe(true);
    expect(isOwnTourPhotoUrl('/images/tours/tour_abc.jpg')).toBe(true);
    expect(isOwnTourPhotoUrl('https://evil.example/images/tours/x.jpg')).toBe(false);
    expect(isOwnTourPhotoUrl(`${S3}../secret.jpg`)).toBe(false);
    expect(isOwnTourPhotoUrl('https://s3.twcstorage.ru/bucket-x/images/places/x.jpg')).toBe(false);
  });

  it('больше 20 фото и чужой адрес — отказ; публикацию правкой не включить', () => {
    expect(OwnTourEditSchema.safeParse({ photos: Array.from({ length: 21 }, (_, i) => `${S3}t${i}.jpg`) }).success).toBe(false);
    expect(OwnTourEditSchema.safeParse({ photos: ['https://evil.example/x.jpg'] }).success).toBe(false);
    expect(OwnTourEditSchema.safeParse({ is_published: true }).success).toBe(false);
  });

  it('пустые списки и программа уходят null', () => {
    const body = extrasBody({ program: [{ title: '  ', text: '' }], included: '\n', not_included: '', what_to_bring: '', safety_notes: '', photos: [], video_clips: [], photo_credit: '' });
    expect(body).toMatchObject({ program: null, included: null, not_included: null, what_to_bring: null, safety_notes: null, photos: [] });
    expect(OwnTourEditSchema.safeParse(body).success).toBe(true);
  });
});
