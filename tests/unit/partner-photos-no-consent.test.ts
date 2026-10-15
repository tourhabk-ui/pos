/**
 * Снимки «Местечка Камчатка» вне его туров — до согласия партнёра (15.10).
 *
 * Владелец на вопрос, покрывает ли «ДА» партнёра на снимки туров (1217)
 * карточки мест: «пока нет получим согласе востановим». Поведение на базе —
 * карточка, фото маршрута, раздача, возврат — судит
 * tests/integration/partner-photos-no-consent.pg.test.ts. Здесь — то, что
 * живёт в коде, а не в базе: род в словаре показа, главные кадры статей
 * летописи и снимки владельца, которыми их заменили.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KEEP_MODELS, PARTNER_NO_CONSENT, SHOWN_MODELS, keepPhotoSql, shownPhotoSql, whyNotShown,
} from '@/lib/images/origin';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';

const ROOT = process.cwd();
const sha256 = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');

describe('род «снимок партнёра без согласия»', () => {
  it('не показывается, но и не перезаписывается сборщиком Commons — вернуть будет что', () => {
    expect(SHOWN_MODELS as readonly string[]).not.toContain(PARTNER_NO_CONSENT);
    expect(shownPhotoSql('m')).not.toContain(PARTNER_NO_CONSENT);
    expect(KEEP_MODELS as readonly string[]).toContain(PARTNER_NO_CONSENT);
    expect(keepPhotoSql('m')).toContain(`'${PARTNER_NO_CONSENT}'`);
  });

  it('причина скрытия — права и решение владельца, а не «род не в списке»', () => {
    const why = whyNotShown(PARTNER_NO_CONSENT);
    expect(why).toMatch(/согласия на показ на карточках мест пока нет/);
    expect(why).not.toBe(whyNotShown('какой-то-новый-род'));
  });
});

describe('летопись: главных кадров партнёра нет до его согласия', () => {
  it('ни одна статья не ставит снимок «Местечка Камчатка» главным кадром', () => {
    for (const a of CHRONICLE_ARTICLES) {
      if (!a.hero) continue;
      expect(a.hero.key, a.slug).not.toMatch(/mestechko/);
      expect(a.hero.author, a.slug).not.toBe('Местечко Камчатка');
    }
  });

  it('«Налычево» и «Вилючинский» — снимки владельца: те же байты, что его исходники, и они в хранилище', () => {
    const marker = JSON.parse(readFileSync(join(ROOT, '.github/triggers/media-to-s3.json'), 'utf-8')) as {
      items: Array<{ file: string; key: string }>;
    };
    // Исходники владельца — снимки миграций 985 (Корякская сопка вечером) и
    // 979 (Вилючинский с облачным поясом); их ключ в хранилище — хэш байтов.
    const cases = [
      { slug: 'nalychevo', key: 'photos/nalychevo/vladelec-koryakskaya-sopka-vecherom.jpg', original: '804cf57c49320b6be83b40eaf2e7052a14ef08afda5e98abd950b6ed1a015ee2', from: '985_koryaksky_evening_gallery.sql' },
      { slug: 'vilyuchinskij-park', key: 'photos/vilyuchinsky/vladelec-oblachnyj-poyas.jpg', original: '853153582f366d4ae158232755482abd3a1aeab87588ba3817c862d10ffe82cc', from: '979_vilyuchinsky_owner_photos.sql' },
    ];
    for (const c of cases) {
      const a = CHRONICLE_ARTICLES.find((x) => x.slug === c.slug);
      expect(a?.hero?.key, c.slug).toBe(c.key);
      expect(a?.hero?.author, c.slug).toBe('владелец платформы');
      const item = marker.items.find((i) => i.key === c.key);
      expect(item, c.key).toBeDefined();
      expect(sha256(item!.file), c.key).toBe(c.original);
      // Хэш — тот самый, под которым снимок владельца лёг в своей миграции.
      expect(readFileSync(join(ROOT, 'migrations', c.from), 'utf-8'), c.from).toContain(c.original);
    }
  });
});
