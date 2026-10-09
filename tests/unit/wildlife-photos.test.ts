// @vitest-environment node
/**
 * Снимки медведей с названным автором (Сладченко Виктор Леонидович, 09.10).
 *
 * Реестр один, подпись берётся из него везде, где кадр показан. Сторож держит:
 * файлы на месте; автор в реестре совпадает с подписью в миграции 1186 (две
 * подписи одного кадра разошлись бы); чужая картинка с водяным знаком не
 * вернулась в каталог; каждая поверхность подписывает кадр и не приписывает ему
 * места съёмки.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEAR_FALLBACK, BEAR_PHOTOS, WILDLIFE_AUTHOR, shortCredit } from '@/lib/media/wildlife-photos';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

describe('реестр кадров', () => {
  const all = Object.values(BEAR_PHOTOS);

  it('шесть кадров, все файлы лежат в репозитории, у каждого автор, описание и alt', () => {
    expect(all).toHaveLength(6);
    for (const p of all) {
      expect(existsSync(join(ROOT, 'public', p.src)), p.src).toBe(true);
      expect(p.credit).toBe(WILDLIFE_AUTHOR);
      expect(p.alt.length).toBeGreaterThan(10);
      expect(p.shows.length).toBeGreaterThan(20);
    }
  });

  it('подпись в реестре совпадает с картой подписей миграции 1186: у кадра один автор', () => {
    const sql = read('migrations/1186_partner_gallery_credits_and_clips.sql').replace(/--[^\n]*/g, '');
    for (const p of all) {
      expect(sql, p.src).toContain(`'${p.src}', '${p.credit}'`);
    }
  });

  it('место съёмки не приписано: ни в описаниях, ни в подписях', () => {
    for (const p of all) {
      expect(`${p.alt} ${p.shows}`, p.src).not.toMatch(/Курильск|Кроноцк|Халактыр|озер[оа]\s+[А-ЯЁ]|заповедник/);
    }
  });

  it('подпись для тесного места — фамилия и инициалы', () => {
    expect(shortCredit('Сладченко Виктор Леонидович')).toBe('Сладченко В. Л.');
    expect(shortCredit('Иванов')).toBe('Иванов');
  });
});

describe('чужой снимок удалён (владелец 09.10: «да»)', () => {
  it('файл с водяным знаком AirPano и его варианты убраны из public/ и из манифеста вариантов', () => {
    for (const f of ['medvedi.jpg', 'medvedi.320.webp', 'medvedi.640.webp']) {
      expect(existsSync(join(ROOT, 'public/images/categories', f)), f).toBe(false);
    }
    expect(read('lib/images/photo-variants.json')).not.toMatch(/categories\/medvedi/);
  });

  it('ни один исходник на него не ссылается', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync("grep -rln 'categories/medvedi' app components lib hooks --include=*.ts --include=*.tsx || true", { cwd: ROOT, encoding: 'utf-8' }).trim();
    expect(out).toBe('');
  });
});

describe('миграция 1190: автор вечерних кадров', () => {
  const sql = read('migrations/1190_shatun_evening_photos_author.sql').replace(/--[^\n]*/g, '');

  it('shatun-01..03 получают подпись автора со слов владельца; кадры 04..15 не трогаются', () => {
    for (const n of ['01', '02', '03']) {
      expect(sql).toContain(`'/images/shatun/shatun-${n}.jpg'`);
    }
    expect(sql).not.toMatch(/shatun-(0[4-9]|1[0-5])\.jpg/);
    expect(sql.match(/Сладченко Виктор Леонидович/g)).toHaveLength(3 + 1);
  });

  it('карта дополняется, а не заменяется; существующий ключ не перезаписывается', () => {
    expect(sql).toMatch(/p\.gallery_credits \|\| jsonb_strip_nulls/);
    expect(sql.match(/WHEN p\.gallery_credits \? '/g)).toHaveLength(3);
  });
});

describe('заглушка категории «Медведи»', () => {
  it('каталог берёт кадр из реестра, чужой снимок с водяным знаком (AirPano) больше не используется', () => {
    const m = read('components/marketplace/MarketplaceClient.tsx');
    expect(m).toMatch(/bears:\s+BEAR_FALLBACK\.src/);
    expect(m).not.toMatch(/categories\/medvedi\.jpg/);
    expect(BEAR_FALLBACK).toBe(BEAR_PHOTOS.portrait);
  });

  it('подпись автора видна только на заглушке, свой снимок тура не подписывается', () => {
    const m = read('components/marketplace/MarketplaceClient.tsx');
    expect(m).toMatch(/const placeholderCredit = !tour\.tour_image && tour\.activity_type === 'bears' \? BEAR_FALLBACK\.credit : null;/);
    expect(m).toMatch(/\{placeholderCredit && \(/);
    expect(m).toMatch(/Фото: \{shortCredit\(placeholderCredit\)\}/);
  });

  it('зимняя дорога больше не стоит заглушкой «Медведей» в API каталога и в админке', () => {
    expect(read('app/api/tours/route.ts')).toMatch(/medvedi:\s+BEAR_FALLBACK\.src/);
    expect(read('app/api/tours/[id]/route.ts')).toMatch(/medvedi:\s+BEAR_FALLBACK\.src/);
    expect(read('app/hub/admin/videos/page.tsx')).not.toMatch(/slug: 'medvedi'[^\n]*road-winter/);
  });
});

describe('памятка «Медведь» на главной', () => {
  const home = read('app/_home/_HomeV8Client.tsx');

  it('кадр только у протокола про медведя; подпись автора — под кадром', () => {
    expect(home).toMatch(/photo: BEAR_PHOTOS\.standing,/);
    expect(home.match(/photo: BEAR_PHOTOS\./g)).toHaveLength(1);
    expect(home).toMatch(/<figcaption>Фото: \{photo\.credit\}<\/figcaption>/);
  });

  it('памятка живёт без сети: не пришёл кадр — фигуры нет вовсе, текст шагов не зависит от кадра', () => {
    expect(home).toMatch(/onError=\{\(\) => setFailed\(true\)\}/);
    expect(home).toMatch(/if \(failed\) return null;/);
    expect(home).toMatch(/loading="lazy"/);
    // шаги рисуются отдельным списком до кадра
    const open = home.slice(home.indexOf('<ol className="emg-steps">'), home.indexOf('<ProtoPhoto photo={p.photo} />'));
    expect(open).toContain('p.steps.map');
  });

  it('подпись кадра нейтральна: о намерении зверя он ничего не говорит', () => {
    expect(BEAR_PHOTOS.standing.alt).toMatch(/стоит на задних лапах/);
    for (const text of [BEAR_PHOTOS.standing.alt, BEAR_PHOTOS.standing.shows]) {
      expect(text).not.toMatch(/любопыт|агресс|атак|угрож/i);
    }
  });
});

describe('посты канала про медведей', () => {
  it('две темы с кадрами автора; подпись ставит код под текст, а не просьба к модели', async () => {
    const { KUZMICH_TIP_TOPIC_LIST } = await import('@/lib/notifications/telegram-channel');
    const credited = KUZMICH_TIP_TOPIC_LIST.filter((t) => t.credit);
    expect(credited).toHaveLength(2);
    for (const t of credited) {
      expect(t.credit).toBe(WILDLIFE_AUTHOR);
      expect(Object.values(BEAR_PHOTOS).some((p) => p.src === t.photo), t.topic).toBe(true);
    }
    const src = read('lib/notifications/telegram-channel.ts');
    expect(src).toMatch(/picked\.credit \? `\$\{text\}\\n\\n<i>Фото: \$\{picked\.credit\}<\/i>` : text/);
    expect(src).toMatch(/text: captioned, photoUrl/);
  });

  it('у снимков без названного автора подписи нет: чужим именем кадры не подписываем', async () => {
    const { KUZMICH_TIP_TOPIC_LIST } = await import('@/lib/notifications/telegram-channel');
    const own = new Set(Object.values(BEAR_PHOTOS).map((p) => p.src));
    for (const t of KUZMICH_TIP_TOPIC_LIST) {
      if (!own.has(t.photo)) expect(t.credit, t.topic).toBeUndefined();
    }
  });
});
