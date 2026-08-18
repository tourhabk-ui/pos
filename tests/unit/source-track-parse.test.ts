/**
 * Разбор трека со страницы источника — ОДИН на всех.
 *
 * Копий было две, и каждая несла баг, вылеченный в другой: прод-разбор не
 * проверял границы края (профиль высот уезжал в базу как трек и рисовался
 * зелёной линией через весь край), а разбор в скрипте терял высоту в порядке
 * «широта первой» — ту самую, ради которой чинили прод.
 *
 * Сторож держит оба свойства сразу и ищет возврат второй копии.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTrackBlocks } from '@/lib/services/ingest/track-parse';

/** Настоящий трек Камчатки в порядке GeoJSON: [долгота, широта, высота]. */
const geoJsonBlock = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => [158.4 + i * 0.001, 53.25 + i * 0.001, 700 + i * 5]),
);
/** Он же в порядке «широта первой» — так отдаёт источник. */
const latFirstBlock = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => [53.25 + i * 0.001, 158.4 + i * 0.001, 700 + i * 5]),
);
/** Профиль высот: расстояние от старта и высота. Координатами не является. */
const elevationProfile = JSON.stringify(
  Array.from({ length: 40 }, (_, i) => [i * 1.2, 795 + i * 3]),
);

describe('разбор трека со страницы источника', () => {
  it('высота переживает оба порядка осей', () => {
    for (const block of [geoJsonBlock, latFirstBlock]) {
      const r = parseTrackBlocks(`<script>var t = ${block};</script>`);
      expect(r.coordinates.length).toBe(12);
      expect(r.hasElevation, 'высота потеряна — это баг разбора в скрипте').toBe(true);
      // Порядок на выходе всегда GeoJSON: долгота первой.
      expect(r.coordinates[0][0]).toBeGreaterThan(90);
      expect(r.coordinates[0][2]).toBe(700);
    }
  });

  it('профиль высот треком не становится', () => {
    const r = parseTrackBlocks(`<script>var profile = ${elevationProfile};</script>`);
    expect(r.coordinates, 'профиль высот прочитан как координаты').toHaveLength(0);
    expect(r.rejected.not_on_map).toBeGreaterThan(0);
  });

  it('профиль высот не побеждает трек длиной', () => {
    // На странице оба блока, профиль ДЛИННЕЕ. Прежний разбор брал длиннейший
    // из принятых, а принимал он профиль — то есть длина решала за правду.
    const r = parseTrackBlocks(
      `<script>var t = ${latFirstBlock}; var p = ${elevationProfile};</script>`,
    );
    expect(r.coordinates.length).toBe(12);
    expect(r.hasElevation).toBe(true);
  });

  it('блок с одной точкой вне края отвергается целиком', () => {
    const spoiled = JSON.parse(latFirstBlock) as number[][];
    spoiled[7] = [0, 795];
    const r = parseTrackBlocks(`<script>var t = ${JSON.stringify(spoiled)};</script>`);
    expect(r.coordinates).toHaveLength(0);
  });

  it('разбор живёт в одном месте — второй копии нет', () => {
    // Копии расходятся молча: у каждой из двух прежних был баг, вылеченный в
    // другой. Сторож ищет ту самую эвристику по ПЕРВОЙ точке.
    const files = [
      'lib/services/ingest/idilesom-importer.ts',
      'scripts/import-idilesom-tracks.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf-8');
      expect(
        /Math\.abs\(\s*first\[0\]/.test(src),
        `${f}: порядок осей снова решается по одной точке — разбор раздвоился`,
      ).toBe(false);
      expect(
        src.includes('parseTrackBlocks'),
        `${f}: разбирает трек мимо общего правила`,
      ).toBe(true);
    }
  });
});
