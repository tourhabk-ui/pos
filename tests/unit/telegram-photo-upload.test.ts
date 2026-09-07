/**
 * Сторож отправки снимка БАЙТАМИ (07.09).
 *
 * Журнал прода назвал причину словами дважды:
 *
 *   channel_photo_fallback       «Bad Request: failed to get HTTP URL content»
 *   channel_media_group_fallback «WEBPAGE_CURL_FAILED»
 *
 * Оба кода значат одно: Bot API попытался СКАЧАТЬ наш URL и не смог. Снимки
 * при этом живы — перепись с прода отдала `200 · image/jpeg · 68–214 КБ`, и с
 * раннера GitHub они качаются тоже.
 *
 * Пока публикация даёт ссылку, она зависит от того, дойдёт ли чужой сервер до
 * нашего хоста, — условие, которого мы не контролируем. Байты его убирают.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TELEGRAM_UPLOAD_MAX_BYTES, isFetched } from '@/lib/notifications/telegram-upload';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const CHANNEL = strip(readFileSync(join(process.cwd(), 'lib/notifications/telegram-channel.ts'), 'utf8'));
const UPLOAD = strip(readFileSync(join(process.cwd(), 'lib/notifications/telegram-upload.ts'), 'utf8'));

describe('снимок уходит байтами, а не ссылкой', () => {
  it('одиночное фото пробует загрузку ПЕРЕД ссылкой', () => {
    const fn = CHANNEL.slice(CHANNEL.indexOf('async function tgSendPhotoOnce'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/fetchPhotoForUpload\(photoUrl\)/);
    expect(body.indexOf('fetchPhotoForUpload')).toBeLessThan(body.indexOf('tgFetchWithRetry'));
    expect(body).toMatch(/form\.append\('photo', fetched\.blob, fetched\.filename\)/);
  });

  it('альбом прикладывает кадры файлами через attach://', () => {
    expect(CHANNEL).toMatch(/attach:\/\/p\$\{i\}/);
    expect(CHANNEL).toMatch(/form\.append\(`p\$\{i\}`, f\.blob, f\.filename\)/);
  });

  it('ссылка осталась запасным путём, а не исчезла', () => {
    // «Мы не смогли скачать свой файл» и «Telegram не смог скачать» — разные
    // беды, и вторая ссылкой ещё может решиться.
    expect(CHANNEL).toMatch(/свой снимок не скачался, пробуем ссылкой/);
  });
});

describe('скачивание своего снимка честно к отказам', () => {
  it('не-картинка отвергается до отправки', () => {
    expect(UPLOAD).toMatch(/contentType\.startsWith\('image\/'\)/);
  });

  it('пустое тело и перебор потолка названы отдельно', () => {
    expect(UPLOAD).toMatch(/пустое тело ответа/);
    expect(UPLOAD).toMatch(/больше потолка Telegram/);
    expect(TELEGRAM_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('отказ возвращается, а не бросается', () => {
    // Молчаливое исключение превратило бы отказ сети в «фотографии нет».
    expect(UPLOAD).toMatch(/return \{ error:/);
    expect(isFetched({ error: 'нет' })).toBe(false);
  });
});
