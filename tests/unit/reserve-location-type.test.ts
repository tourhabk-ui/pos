/**
 * Тип «Заповедник» (reserve) и Кроноцкий заповедник — владелец 14.10:
 * «Кроноцкий заповедник нужно завести и сделать страницу описания».
 *
 * Тип без производителя — провод в никуда (правило 10.09): держим связку
 * целиком — подпись, место в счёте стихий и миграцию, которая тип кому-то
 * выдала. Миграция судится по смыслу: какой записи что выдано, откуда
 * координата, и что умолчания профиля безопасности не выдаются за факт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationTypeLabel } from '@/lib/places/location-types';
import { EXCLUDED_TYPES } from '@/lib/stats/element-groups';
import { insideKrai } from '@/lib/geo/krai-envelope';

const sql = readFileSync(join(process.cwd(), 'migrations/1240_kronotsky_reserve_place.sql'), 'utf8');
/** Тело без комментариев: шапка рассказывает историю, судится то, что выполнится. */
const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const PLACE_ID = '4f1217e7-31a4-4d21-bc98-3d46aaba122e';

describe('reserve — объявлен вместе с производителем', () => {
  it('подпись своя: заповедник не «Природный парк» и не «Лесной массив»', () => {
    expect(locationTypeLabel('reserve')).toBe('Заповедник');
    expect(locationTypeLabel('reserve')).not.toBe(locationTypeLabel('park'));
  });

  it('территория, как парк: в счёт стихий не идёт, но и не теряется', () => {
    expect(EXCLUDED_TYPES).toContain('reserve');
    expect(EXCLUDED_TYPES).toContain('park');
  });

  it('миграция 1240 выдаёт тип одной записи — по id, не по похожести имени', () => {
    const insert = body.slice(body.indexOf('INSERT INTO places'), body.indexOf('ON CONFLICT (id)'));
    expect(insert).toContain(`'${PLACE_ID}'`);
    expect(insert).toContain("'reserve'");
    expect(insert).toContain("'Кроноцкий заповедник'");
    expect(body).not.toMatch(/UPDATE places[\s\S]*?location_type\s*=\s*'reserve'/);
    expect(body).not.toMatch(/ILIKE|~\*/);
  });
});

describe('Кроноцкий заповедник: запись по источникам', () => {
  it('координата — точка OSM отношения 2800189, на суше внутри края; источник назван', () => {
    const m = body.match(/(\d{2}\.\d+),\s*(\d{3}\.\d+),\s*\n\s*'reserve'/);
    expect(m).not.toBeNull();
    const lat = Number(m![1]);
    const lng = Number(m![2]);
    expect(lat).toBeCloseTo(54.6245727, 5);
    expect(lng).toBeCloseTo(160.8792322, 5);
    expect(insideKrai(lat, lng)).toBe(true);
    expect(body).toContain('https://www.openstreetmap.org/relation/2800189');
    expect(body).toContain("'external'");
  });

  it('год основания — 1934, не 1884 из прежнего сочинения (миграция 153)', () => {
    expect(body).toContain('1934');
    expect(body).not.toContain('1884');
  });

  it('порядок посещения — официальная страница заявки, режим — государственный заповедник', () => {
    expect(body).toContain("'https://kronoki.ru/ru/visit/requests/'");
    expect(body).toContain("'federal_reserve'");
    expect(body).toContain('tourism@kronoki.ru');
  });

  it('профиль безопасности: опасности из паспортов, умолчания 0645 явно NULL', () => {
    const profile = body.slice(body.indexOf('INSERT INTO location_safety_profile'));
    const cols = profile.slice(profile.indexOf('(') + 1, profile.indexOf(')')).split(',').map((s) => s.trim());
    // Вместимость 50, сложность 2 и «коммуникатор не нужен» — умолчания
    // таблицы; без явного NULL они легли бы фактом о заповеднике.
    for (const c of ['capacity_per_day', 'difficulty_level', 'sat_communicator_required']) {
      expect(cols).toContain(c);
    }
    const values = profile.slice(profile.indexOf('SELECT p.ark_id,') + 'SELECT p.ark_id,'.length, profile.indexOf('FROM places p'))
      .split(',').map((s) => s.trim());
    for (const c of ['capacity_per_day', 'difficulty_level', 'sat_communicator_required']) {
      // Колонки идут после agent_route_id — сдвиг на одну позицию.
      expect(values[cols.indexOf(c) - 1]).toBe('NULL');
    }
    expect(profile).toContain("ARRAY['bears', 'thermal']");
    expect(profile).toContain("'manual'");
  });

  it('другие имена — из OSM и Википедии, включая английское и китайское', () => {
    expect(body).toContain("'Kronotsky Nature Reserve'");
    expect(body).toContain("'克罗诺基自然保护区'");
    expect(body).toContain("'Кроноцкий государственный природный биосферный заповедник'");
  });
});

describe('снимки заповедника (миграция 1241)', () => {
  const photos = readFileSync(join(process.cwd(), 'migrations/1241_kronotsky_reserve_photos.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const marker = JSON.parse(readFileSync(join(process.cwd(), '.github/triggers/media-to-s3.json'), 'utf8')) as {
    items: Array<{ key: string }>;
  };
  // Ключ героя повторяется в проверке исхода в конце миграции — считаем различные.
  const keys = [...new Set([...photos.matchAll(/'(photos\/kronotsky\/[a-z0-9-]+\.jpg)'/g)].map((m) => m[1]))];

  it('каждый ключ залит в хранилище тем же путём (media-to-s3) — битого снимка не будет', () => {
    expect(keys.length).toBe(8);
    const uploaded = new Set(marker.items.map((i) => i.key));
    for (const k of keys) expect(uploaded.has(k), k).toBe(true);
  });

  it('у каждого снимка автор, свободная лицензия и страница файла; герой — показываемый род', () => {
    // Восемь строк — восемь ссылок на страницы файлов Commons и лицензий CC.
    expect((photos.match(/https:\/\/commons\.wikimedia\.org\/wiki\/File:/g) ?? []).length).toBe(8);
    expect((photos.match(/'CC BY-SA [34]\.0'/g) ?? []).length).toBe(8);
    expect(photos).toContain("'wikimedia'");
    // Чужой показываемый снимок (фото владельца, ручная загрузка) не затирается.
    expect(photos).toMatch(/WHERE ai_route_images\.model NOT IN \('wikimedia', 'manual-upload'\)\s+OR ai_route_images\.prompt = EXCLUDED\.prompt/);
    expect(photos).toContain('ON CONFLICT (ark_id, position) DO NOTHING');
    expect(photos).toContain(`'${PLACE_ID}'`);
  });
});
