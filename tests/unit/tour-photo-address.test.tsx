// @vitest-environment jsdom
/**
 * Адрес снимка тура: что можно сохранить и что можно открыть (план готовности
 * 23.11, этап 4; находка ревью безопасности).
 *
 * Очередь администратора показывает превью снимка из правки партнёра и даёт
 * открыть его целиком — ставит адрес в ссылку. Дверь оператора принимала
 * любую строку: `javascript:…` доходил до ссылки в админке и выполнился бы от
 * имени администратора, стоит ему нажать на «снимок».
 *
 * Судится вызовом правила и двери и рендером экрана. Дверь целиком на
 * настоящем PostgreSQL — tests/integration/tour-moderation.pg.test.ts.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/database', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { TourEditDiff, TourEditPhotos, TourEditValue } from '@/components/tours/TourEditDiff';
import { openablePhotoAddress, photoAddressHasForeignScheme, PHOTO_ADDRESS_TEXT } from '@/lib/tours/photo-address';
import { CreateTourSchema, UpdateTourSchema } from '@/lib/api/operator-tours';

afterEach(() => cleanup());

/** Адреса, которые не должны стать ни ссылкой, ни записью в базе. */
const HOSTILE = [
  'javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  '  javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://vedarai.ru/1b2c',
];
const SITE_PATHS = ['/images/tours/a.jpg', '/api/images/s3/photos/partner/a.640.webp', '/api/photos/images/tours/a.jpg'];
const WEB = ['https://s3.twcstorage.ru/bucket/images/tours/a.jpg', 'https://example.com/photo.jpg', 'http://example.com/photo.jpg'];

describe('правило адреса снимка', () => {
  it('открыть можно путь нашего сайта и http(s) — и только их', () => {
    for (const url of SITE_PATHS) expect(openablePhotoAddress(url), url).toBe(url);
    for (const url of WEB) expect(openablePhotoAddress(url), url).toBe(url);
    for (const url of HOSTILE) expect(openablePhotoAddress(url), JSON.stringify(url)).toBeNull();
    // Чужой хост без схемы, имя файла без пути, пустота и не-строка — не адрес.
    for (const url of ['//evil.example/a.jpg', '/\\evil.example', 'photo.jpg', 'images/a.jpg', '', ' ', null, undefined, 7, {}]) {
      expect(openablePhotoAddress(url), JSON.stringify(url)).toBeNull();
    }
  });

  it('чужая схема — всё, кроме http(s); строка без схемы чужой схемы не несёт', () => {
    for (const url of HOSTILE) expect(photoAddressHasForeignScheme(url), JSON.stringify(url)).toBe(true);
    for (const url of [...SITE_PATHS, ...WEB, 'photo.jpg', 'images/a.jpg', '']) {
      expect(photoAddressHasForeignScheme(url), url).toBe(false);
    }
  });
});

describe('дверь оператора: адрес снимка с чужой схемой не сохраняется', () => {
  const firstError = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) => r.error?.issues[0]?.message;

  it('правка тура: снимки и обложка с чужой схемой отклонены словами', () => {
    for (const url of HOSTILE) {
      const photos = UpdateTourSchema.safeParse({ photos: ['/images/tours/a.jpg', url] });
      expect(photos.success, JSON.stringify(url)).toBe(false);
      expect(firstError(photos)).toBe(PHOTO_ADDRESS_TEXT);
      const cover = UpdateTourSchema.safeParse({ tour_image: url });
      expect(cover.success, JSON.stringify(url)).toBe(false);
      expect(firstError(cover)).toBe(PHOTO_ADDRESS_TEXT);
    }
  });

  it('новый тур: то же правило у обоих полей', () => {
    for (const url of HOSTILE) {
      expect(CreateTourSchema.shape.photos.safeParse([url]).success, JSON.stringify(url)).toBe(false);
      expect(CreateTourSchema.shape.tour_image.safeParse(url).success, JSON.stringify(url)).toBe(false);
    }
  });

  it('загруженное здесь и ссылка на свой сайт проходят; обложку можно снять', () => {
    expect(UpdateTourSchema.safeParse({ photos: [...SITE_PATHS, ...WEB] }).success).toBe(true);
    for (const url of [...SITE_PATHS, ...WEB]) expect(UpdateTourSchema.safeParse({ tour_image: url }).success, url).toBe(true);
    expect(UpdateTourSchema.safeParse({ tour_image: null }).success).toBe(true);
    expect(UpdateTourSchema.safeParse({ photos: [] }).success).toBe(true);
    // Старая запись без пути правку не запирает: чужой схемы в ней нет.
    expect(UpdateTourSchema.safeParse({ photos: ['photo.jpg'] }).success).toBe(true);
  });
});

describe('очередь администратора: снимки правки', () => {
  /** Всё, что браузер может исполнить или загрузить из вёрстки. */
  const targets = () => [...document.querySelectorAll('[href], [src], [action], [formaction]')]
    .map((el) => el.getAttribute('href') ?? el.getAttribute('src') ?? el.getAttribute('action') ?? el.getAttribute('formaction') ?? '');

  it('снимок с адресом сайта или http(s): превью и ссылка «открыть целиком»', () => {
    render(<TourEditPhotos urls={['/images/tours/a.jpg', 'https://example.com/b.jpg']} label="Фото: станет" />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/images/tours/a.jpg', 'https://example.com/b.jpg']);
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual(['/images/tours/a.jpg', 'https://example.com/b.jpg']);
    for (const a of links) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByTestId('photo-not-openable')).toBeNull();
  });

  it.each(HOSTILE.map((u) => [u]))('адрес %j: ни ссылки, ни картинки — только текст и пометка', (url) => {
    render(<TourEditPhotos urls={[url]} label="Фото: станет" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(targets()).toEqual([]);
    const note = screen.getByTestId('photo-not-openable');
    expect(note.textContent).toContain('Адрес снимка не открывается');
    // Что прислал партнёр, администратор видит — текстом.
    expect(note.textContent).toContain(url);
  });

  it('безопасный и небезопасный рядом: первый открыт, второй — текст', () => {
    render(<TourEditPhotos urls={['/images/tours/a.jpg', 'javascript:alert(1)', 'photo.jpg']} label="Фото" />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getAllByTestId('photo-not-openable')).toHaveLength(2);
    expect(targets().every((t) => t === '/images/tours/a.jpg')).toBe(true);
  });

  it('тем же правилом — значение поля и дифф «сейчас / станет»', () => {
    render(<TourEditValue text="" photos={['javascript:alert(1)']} label="Обложка" />);
    expect(targets()).toEqual([]);
    cleanup();
    render(<TourEditDiff changes={[{
      field: 'photos', label: 'Фото', before: '', after: '',
      beforePhotos: ['/images/tours/a.jpg'], afterPhotos: ['javascript:alert(1)', 'data:text/html,x'],
    } as never]} />);
    expect(targets()).toEqual(['/images/tours/a.jpg', '/images/tours/a.jpg']);
    expect(screen.getAllByTestId('photo-not-openable')).toHaveLength(2);
  });
});
