// @vitest-environment node
/**
 * Наш ли адрес снимка (14.10, слово владельца: «Только используй наши
 * фотографии») — вызовом на граничных адресах.
 *
 * places.photo_url и places.images собраны импортом с посторонних сайтов;
 * показывать можно только путь сайта, наш домен и объект нашего хранилища.
 * Хранилище узнаётся по базе из окружения (имя бакета в репозитории не живёт),
 * поэтому модуль грузится заново под каждое окружение.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('@/lib/images/own-image-url');
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('isOwnImageUrl', () => {
  it('путь сайта и наш домен — наши; чужой хост, «//хост», http и похожий домен — нет', async () => {
    const { isOwnImageUrl } = await load({ S3_BUCKET: '' });
    for (const own of ['/api/images/route/9f1c?v=1', '/images/places/avacha.webp', '/api/images/place-gallery/9f1c/2',
      'https://vedarai.ru/images/hero/hero-light.1024.webp', 'https://www.vedarai.ru/images/x.jpg']) {
      expect(isOwnImageUrl(own), own).toBe(true);
    }
    for (const foreign of ['https://visitkamchatka.ru/upload/iblock/1.jpg', '//cdn.example.com/x.jpg',
      'http://vedarai.ru/images/x.jpg', 'https://vedarai.ru.evil.example/x.jpg', 'data:image/png;base64,AAAA',
      'javascript:alert(1)', '', '   ', 'images/relative.jpg']) {
      expect(isOwnImageUrl(foreign), foreign).toBe(false);
    }
    expect(isOwnImageUrl(null)).toBe(false);
    expect(isOwnImageUrl(42)).toBe(false);
  });

  it('объект нашего бакета — наш; соседний бакет и бакет с тем же началом имени — нет', async () => {
    const { isOwnImageUrl } = await load({ S3_ENDPOINT: 'https://s3.example.test', S3_BUCKET: 'vedar-media' });
    expect(isOwnImageUrl('https://s3.example.test/vedar-media/places/avacha.jpg')).toBe(true);
    expect(isOwnImageUrl('https://s3.example.test/other-bucket/places/avacha.jpg')).toBe(false);
    expect(isOwnImageUrl('https://s3.example.test/vedar-media-evil/places/avacha.jpg')).toBe(false);
  });

  it('бакет не задан — адрес хранилища нашим не считается', async () => {
    const { isOwnImageUrl } = await load({ S3_ENDPOINT: 'https://s3.example.test', S3_BUCKET: '' });
    expect(isOwnImageUrl('https://s3.example.test/vedar-media/places/avacha.jpg')).toBe(false);
  });
});

describe('ownImageUrls и ownPlacePhoto', () => {
  it('из списка — только наши адреса, порядок прежний; не список — пусто', async () => {
    const { ownImageUrls } = await load({ S3_BUCKET: '' });
    expect(ownImageUrls(['https://foreign.example/a.jpg', '/images/b.jpg', 7, 'https://vedarai.ru/c.jpg']))
      .toEqual(['/images/b.jpg', 'https://vedarai.ru/c.jpg']);
    expect(ownImageUrls(null)).toEqual([]);
    expect(ownImageUrls('/images/b.jpg')).toEqual([]);
  });

  it('свой снимок места первым; затем наш photo_url; затем первый наш из списка; чужие — никогда', async () => {
    const { ownPlacePhoto } = await load({ S3_BUCKET: '' });
    const foreign = 'https://visitkamchatka.ru/upload/1.jpg';
    expect(ownPlacePhoto('/api/images/route/9f1c', foreign, [foreign])).toBe('/api/images/route/9f1c');
    expect(ownPlacePhoto(null, '/images/places/a.jpg', [foreign])).toBe('/images/places/a.jpg');
    expect(ownPlacePhoto(null, foreign, [foreign, '/images/places/b.jpg'])).toBe('/images/places/b.jpg');
    expect(ownPlacePhoto(null, foreign, [foreign])).toBeNull();
  });
});
