/**
 * Пост Кузьмича о туре — только с настоящими фотографиями оператора.
 *
 * Наблюдение владельца 27.08: «Кузьмич в тг-канале публикует туры без
 * реальных картинок». Правило существовало с 05.08 (tour-channel-post:
 * фото — только из operator_tours.photos, нет фото — нет поста), но у
 * платформы БЫЛО ДВА постера туров, и второй — postKuzmichTour, регулярный
 * автопостер голосом Кузьмича — правила не знал:
 *
 *  1. тур без фото публиковался голым текстом (photoUrl: null → tgPost);
 *  2. склейка `${appUrl}${photoRel}` ломала уже-абсолютные URL, Telegram не
 *     скачивал битую ссылку — и пост «с фото» тихо уходил текстом;
 *  3. одно фото вместо альбома, хотя стандарт шлёт до 10 снимков оператора.
 *
 * Тот же урок, что с картой (§12 CLAUDE.md): правило, реализованное дважды, —
 * это два правила, и они разошлись. Сторож держит один путь для обоих.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { absolutePhotoUrls, MAX_PHOTOS } from '@/lib/notifications/photo-urls';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const TG = read('lib/notifications/telegram-channel.ts');
const TOUR_POST = read('lib/notifications/tour-channel-post.ts');

/**
 * Тело postKuzmichTour — от объявления до следующего import/export
 * (за функцией в файле идут mid-file импорты новостного поста), БЕЗ
 * строк-комментариев: судим по действиям кода, а не по прозе в нём —
 * пояснение «прежняя склейка ломала URL» не должно ловиться как склейка.
 */
function kuzmichTourBody(): string {
  const start = TG.indexOf('export async function postKuzmichTour');
  expect(start, 'postKuzmichTour пропал из telegram-channel.ts').toBeGreaterThan(-1);
  const rest = TG.slice(start);
  const ends = [rest.indexOf('\nexport ', 10), rest.indexOf('\nimport ', 10)].filter((i) => i !== -1);
  const body = ends.length ? rest.slice(0, Math.min(...ends)) : rest;
  return body
    .split('\n')
    .filter((l) => !/^\s*(\/\/|--)/.test(l))
    .join('\n');
}

describe('postKuzmichTour: фото обязательны', () => {
  const body = kuzmichTourBody();

  it('SQL отбирает только туры с фотографиями', () => {
    expect(body).toMatch(/COALESCE\(array_length\(ot\.photos, 1\), 0\) > 0/);
  });

  it('без пригодных фото пост не публикуется — ни текстом, ни обложкой', () => {
    expect(body).toMatch(/photoUrls\.length === 0/);
    expect(body).toMatch(/пост не публикуется/);
  });

  it('URL фотографий абсолютизируются общим правилом, а не ручной склейкой', () => {
    expect(body).toMatch(/absolutePhotoUrls\(t\.photos, appUrl\)/);
    expect(body, 'вернулась ручная склейка appUrl+photoRel — ломает абсолютные URL')
      .not.toMatch(/\$\{appUrl\}\$\{photoRel\}/);
  });

  it('в канал уходит альбом (photoUrls), а не одиночное photoUrl', () => {
    expect(body).toMatch(/postToAllChannels\(\{ channelId, postType: 'kuzmich_tour', text, photoUrls \}\)/);
  });

  it('сгенерированные обложки в пути тура не участвуют', () => {
    expect(body).not.toMatch(/resolveCoverImage|pollinations|buildPollinationsUrl/i);
  });
});

describe('postToAllChannels: альбом настоящих фото — первый приоритет', () => {
  it('photoUrls идёт через tgPostMediaGroup', () => {
    const start = TG.indexOf('async function postToAllChannels');
    const body = TG.slice(start, start + 2500);
    expect(body).toMatch(/photoUrls && photoUrls\.length > 0/);
    expect(body).toMatch(/tgPostMediaGroup\(mainChannelId, photoUrls, tgText\)/);
  });
});

describe('правило абсолютизации — одно на оба постера туров', () => {
  it('оба модуля берут absolutePhotoUrls из photo-urls', () => {
    expect(TG).toMatch(/from '@\/lib\/notifications\/photo-urls'/);
    expect(TOUR_POST).toMatch(/from '@\/lib\/notifications\/photo-urls'/);
  });

  it('относительный путь клеится к базе, абсолютный — не трогается', () => {
    expect(absolutePhotoUrls(['/images/a.jpg'], 'https://vedarai.ru')).toEqual(['https://vedarai.ru/images/a.jpg']);
    expect(absolutePhotoUrls(['https://cdn.example/a.jpg'], 'https://vedarai.ru')).toEqual(['https://cdn.example/a.jpg']);
  });

  it('альбом ограничен лимитом Telegram', () => {
    const many = Array.from({ length: 15 }, (_, i) => `/images/${i}.jpg`);
    expect(absolutePhotoUrls(many, 'https://vedarai.ru')).toHaveLength(MAX_PHOTOS);
  });
});
