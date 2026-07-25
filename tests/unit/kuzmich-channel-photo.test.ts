/**
 * У постов Кузьмича должна быть картинка — и настоящая.
 *
 * Наблюдение владельца 25.07.2026: в ленте соседний канал идёт со снимком, а
 * совет Кузьмича — голым текстом. Причина оказалась не в отсутствии
 * возможности: фото-путь (tgPostPhoto, снимки в public/images, карты
 * LOCATION_PHOTO/ACTIVITY_PHOTO) работал у постов о МЕСТАХ, а postKuzmichTip
 * звал postToAllChannels без photoUrl.
 *
 * Тест держит два условия, которые легко нарушить незаметно:
 *  1. у каждой темы совета есть картинка;
 *  2. картинка — реальный файл в репозитории, а не выдуманный путь. Битая
 *     ссылка в Telegram молча превращает пост обратно в текстовый (так уже
 *     было с «Большим Калыгирем»), то есть поломка была бы невидимой.
 *
 * Генерация картинок сюда не допускается сознательно: решение 2026-07-17 —
 * AI-пейзажи не показываем. Честный снимок наших термов лучше нарисованного.
 */
import { describe, it, expect } from 'vitest';
import { KUZMICH_TIP_TOPIC_LIST } from '@/lib/notifications/telegram-channel';
import { existsSync } from 'fs';
import { join } from 'path';

describe('советы Кузьмича идут с настоящим фото', () => {
  it('темы вообще есть', () => {
    expect(KUZMICH_TIP_TOPIC_LIST.length).toBeGreaterThan(0);
  });

  it('у каждой темы задана картинка из public/images', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      expect(t.photo, `тема «${t.topic}» без фото`).toBeTruthy();
      expect(t.photo.startsWith('/images/'), `тема «${t.topic}»: фото не из public/images`).toBe(true);
    }
  });

  it('каждый файл существует в репозитории', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      const path = join(process.cwd(), 'public', t.photo);
      expect(existsSync(path), `нет файла ${t.photo} (тема «${t.topic}»)`).toBe(true);
    }
  });

  it('никаких внешних и сгенерированных картинок', () => {
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      expect(/^https?:\/\//.test(t.photo), `тема «${t.topic}»: внешняя ссылка`).toBe(false);
      expect(/pollinations|unsplash|placeholder|generated/i.test(t.photo)).toBe(false);
    }
  });

  it('темы не дублируются', () => {
    const topics = KUZMICH_TIP_TOPIC_LIST.map((t) => t.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });
});
