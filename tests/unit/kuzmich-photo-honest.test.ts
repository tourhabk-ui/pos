/**
 * Кузьмич по фото — только видимое и факты из базы (11.10).
 *
 * Снимок Трёх Братьев от владельца: место узнано верно, но в ответе
 * «на горизонте — Авачинский и Корякский» (за водой сопки, в той стороне
 * Вилючинский) и «их видно почти с любой точки набережной» (Три Брата на входе
 * в бухту, с набережной их не видно). Зрение просили «определять вулканы» без
 * права сказать «не узнал», а модель чата снимка не видела и достраивала его
 * по памяти.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const visionMock = vi.fn();
vi.mock('@/lib/ai/providers', () => ({ callVision: (...a: unknown[]) => visionMock(...a) }));
const placeInfoMock = vi.fn();
vi.mock('@/lib/kuzmich/place-info-tool', () => ({ placeInfoForKuzmich: (...a: unknown[]) => placeInfoMock(...a) }));

import {
  KUZMICH_PHOTO_PROMPT,
  PHOTO_ANSWER_RULE,
  parsePhotoReading,
  photoForModel,
  describeKuzmichPhoto,
} from '@/lib/kuzmich/photo-vision';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

beforeEach(() => {
  visionMock.mockReset();
  placeInfoMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('задание зрению', () => {
  it('только видимое; вершина на горизонте — лишь по отчётливому силуэту; без «откуда видно»', () => {
    expect(KUZMICH_PHOTO_PROMPT).toMatch(/Только то, что видно в кадре/);
    expect(KUZMICH_PHOTO_PROMPT).toMatch(/силуэт отчётливо виден/);
    expect(KUZMICH_PHOTO_PROMPT).toMatch(/сопки на горизонте/);
    expect(KUZMICH_PHOTO_PROMPT).toMatch(/откуда это место видно/);
    expect(KUZMICH_PHOTO_PROMPT).toMatch(/не узнал/);
  });

  it('системная подсказка зрения разрешает «не узнал»', () => {
    const src = read('lib/ai/providers.ts');
    const hint = src.slice(src.indexOf('const VISION_SYSTEM_HINT'), src.indexOf('function visionChatBody'));
    expect(hint).toMatch(/не узнал — так и скажи/);
  });
});

describe('разбор ответа зрения', () => {
  it('две строки: место и что видно', () => {
    expect(parsePhotoReading('Место: Три Брата\nВидно: три скалы в воде у берега, за водой сопки.'))
      .toEqual({ place: 'Три Брата', seen: 'три скалы в воде у берега, за водой сопки.' });
  });

  it('«не узнал» и «похоже на» — с базой не сверяются', () => {
    expect(parsePhotoReading('Место: не узнал\nВидно: озеро в горах.').place).toBeNull();
    const doubt = parsePhotoReading('Место: похоже на Три Брата\nВидно: скалы в воде.');
    expect(doubt.place).toBeNull();
    expect(doubt.seen).toContain('похоже на Три Брата');
  });

  it('формат не соблюдён — весь текст описанием, места нет', () => {
    expect(parsePhotoReading('Скалы в море, осень.')).toEqual({ seen: 'Скалы в море, осень.', place: null });
  });
});

describe('текст для модели чата', () => {
  const reading = { place: 'Три Брата', seen: 'три скалы в воде, за водой сопки.' };

  it('правило про снимок есть всегда — и без места тоже', () => {
    expect(photoForModel({ place: null, seen: 'озеро' }, null)).toContain(PHOTO_ANSWER_RULE);
    expect(PHOTO_ANSWER_RULE).toMatch(/в той стороне/);
    expect(PHOTO_ANSWER_RULE).toMatch(/откуда это место видно/);
  });

  it('факты места — из базы; нет в базе и база не ответила — разные слова', () => {
    expect(photoForModel(reading, { kind: 'found', text: 'Три Брата [скалы]' })).toMatch(/Факты о нём из базы Ведара:\nТри Брата \[скалы\]/);
    expect(photoForModel(reading, { kind: 'absent' })).toMatch(/В базе Ведара его нет/);
    expect(photoForModel(reading, { kind: 'failed' })).toMatch(/не прочитались/);
  });
});

describe('describeKuzmichPhoto', () => {
  it('снимок 11.10: место сверено с базой, факты и правило в тексте', async () => {
    visionMock.mockResolvedValue('Место: Три Брата\nВидно: три базальтовые скалы в воде, за водой сопки противоположного берега.');
    placeInfoMock.mockResolvedValue('Три Брата [скалы]\nСтраница места на сайте: /places/tri-brata');
    const text = await describeKuzmichPhoto('b64', 'image/jpeg');
    expect(visionMock.mock.calls[0][2]).toBe(KUZMICH_PHOTO_PROMPT);
    expect(placeInfoMock).toHaveBeenCalledWith('Три Брата', { pageLinks: true });
    expect(text).toContain('Факты о нём из базы Ведара');
    expect(text).toContain('/places/tri-brata');
    expect(text).toContain(PHOTO_ANSWER_RULE);
  });

  it('база не ответила — «не прочитались» и лог, а не «места нет»', async () => {
    visionMock.mockResolvedValue('Место: Три Брата\nВидно: скалы.');
    placeInfoMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    const text = await describeKuzmichPhoto('b64', 'image/jpeg');
    expect(text).toMatch(/не прочитались/);
    expect(console.error).toHaveBeenCalled();
  });

  it('зрение не ответило — null', async () => {
    visionMock.mockResolvedValue(null);
    expect(await describeKuzmichPhoto('b64', 'image/jpeg')).toBeNull();
    expect(placeInfoMock).not.toHaveBeenCalled();
  });
});

describe('все каналы Кузьмича — через одно правило', () => {
  const CHANNELS = [
    'app/api/ai/chat/route.ts',
    'app/api/telegram/kuzmich/route.ts',
    'app/api/max/kuzmich/route.ts',
    'app/api/whatsapp/kuzmich/route.ts',
  ];
  for (const file of CHANNELS) {
    it(`${file}: describeKuzmichPhoto, своего промпта зрения нет`, () => {
      const src = read(file);
      expect(src).toMatch(/describeKuzmichPhoto\(/);
      expect(src).not.toMatch(/callVision\(/);
    });
  }

  it('отказ разбора фото в Telegram и MAX не глушится', () => {
    for (const file of ['app/api/telegram/kuzmich/route.ts', 'app/api/max/kuzmich/route.ts']) {
      const src = read(file);
      const around = src.slice(src.indexOf('describeKuzmichPhoto('), src.indexOf('describeKuzmichPhoto(') + 400);
      expect(around).toMatch(/console\.error\('\[(telegram|max)\/kuzmich\] фото не разобрано'/);
    }
  });
});
