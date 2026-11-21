/** Снимки PDF плана — только с подписью автора и безопасным адресом (макет 21.11). */
import { describe, it, expect, vi } from 'vitest';
import { creditedPhoto, loadPrintPhotos } from '@/lib/planner/print-photos';

describe('снимки PDF плана', () => {
  it('первый кадр с автором; без подписи и с чужой схемой — нет', () => {
    expect(creditedPhoto({ images: ['/a.jpg', '/b.jpg'], imageCaptions: [null, 'Фото: Автор'] })).toEqual({ src: '/b.jpg', caption: 'Фото: Автор' });
    expect(creditedPhoto({ images: ['javascript:x', 'http://x/y.jpg'], imageCaptions: ['Фото: А', 'Фото: Б'] })).toBeNull();
    expect(creditedPhoto({ images: ['/a.jpg'] })).toBeNull();
    expect(creditedPhoto(null)).toBeNull();
  });

  it('туры читаются по одному разу; отказ — без снимка, а не ошибка', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/2')) throw new Error('down');
      return { ok: true, json: async () => ({ success: true, data: { images: ['/x.jpg'], imageCaptions: ['Фото: Автор'] } }) } as Response;
    });
    const out = await loadPrintPhotos(['1', '1', '2'], f as unknown as typeof fetch);
    expect(out).toEqual({ '1': { src: '/x.jpg', caption: 'Фото: Автор' } });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
