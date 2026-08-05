/**
 * Ручной пост в канал с настоящими фото — альбом, а не AI-обложка.
 *
 * Владелец 06.08: «мы собирались опубликовать в тг канале пост с фотографиями
 * про этот тур» — сплав по Быстрой. Механизм ручного поста существовал, но
 * умел ровно одну генерируемую AI-обложку. Для поста о реальном туре это
 * неприемлемо по той же причине, по которой AI-картинки выкинуты из
 * OpenGraph (#878): нейрокартинка на витрине реального места — обман,
 * который турист обнаружит на месте.
 *
 * Схема получила photos (2–10) — настоящие кадры оператора; при их наличии
 * пост уходит альбомом sendMediaGroup, а генерация обложки НЕ зовётся вовсе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManualChannelPostSchema } from '@/lib/notifications/manual-channel-post';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'lib/notifications/manual-channel-post.ts'), 'utf-8');
const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('схема ручного поста', () => {
  const base = { channel: 'travel', text: 'Т'.repeat(120) };

  it('принимает настоящие фото — от 2 до 10', () => {
    const ok = ManualChannelPostSchema.safeParse({
      ...base,
      photos: ['/images/tours/a.jpg', '/images/tours/b.jpg'],
    });
    expect(ok.success).toBe(true);
  });

  it('одно фото альбомом не считается', () => {
    // Один кадр — это sendPhoto, прежний путь; альбом из одного элемента
    // Telegram отвергает.
    const bad = ManualChannelPostSchema.safeParse({ ...base, photos: ['/images/one.jpg'] });
    expect(bad.success).toBe(false);
  });

  it('больше десяти нельзя — лимит sendMediaGroup', () => {
    const bad = ManualChannelPostSchema.safeParse({
      ...base,
      photos: Array.from({ length: 11 }, (_, i) => `/images/${i}.jpg`),
    });
    expect(bad.success).toBe(false);
  });

  it('лимит текста остаётся 1024 — caption у Telegram', () => {
    const bad = ManualChannelPostSchema.safeParse({ ...base, text: 'Т'.repeat(1025) });
    expect(bad.success).toBe(false);
  });
});

describe('публикация с фото', () => {
  it('идёт альбомом, а не одиночным фото', () => {
    expect(code).toMatch(/tgPostMediaGroup\(channelId, urls, post\.text\)/);
  });

  it('относительные пути становятся абсолютными — Telegram скачивает по URL', () => {
    expect(code).toMatch(/p\.startsWith\('\/'\) \? `\$\{SITE_URL\}\$\{p\}`/);
  });

  it('AI-обложка при настоящих фото не генерируется', () => {
    // resolveCoverImage должен жить только в else-ветке. Проверяем структурно:
    // в ветке с photos его вызова нет.
    // Основная ветка публикации — последнее вхождение условия (первое — догон MAX).
    const start = code.lastIndexOf('post.photos && post.photos.length >= 2');
    const photosBranch = code.slice(start, code.indexOf('} else {', start));
    expect(photosBranch).not.toMatch(/resolveCoverImage/);
    expect(photosBranch).toMatch(/real_photos/);
  });

  it('кросс-пост в MAX использует первый настоящий кадр, а не генерацию', () => {
    // Ветка догона MAX при tg-дубле: с фото обложка не генерируется и там.
    const dupBranch = code.slice(code.indexOf('if (!maxAlready)'), code.indexOf('return { ok: true, duplicate: true }'));
    expect(dupBranch).toMatch(/post\.photos/);
  });
});

describe('триггер-файл текущего поста', () => {
  const trigger = JSON.parse(
    readFileSync(join(ROOT, '.github/triggers/channel-post.json'), 'utf-8'),
  ) as { text: string; photos?: string[] };

  it('валиден по схеме', () => {
    expect(ManualChannelPostSchema.safeParse(trigger).success).toBe(true);
  });

  it('фото существуют в репозитории — битых ссылок в канал не уйдёт', () => {
    for (const p of trigger.photos ?? []) {
      if (!p.startsWith('/')) continue;
      expect(
        () => readFileSync(join(ROOT, 'public', p)),
        `фото не найдено: ${p}`,
      ).not.toThrow();
    }
  });
});
