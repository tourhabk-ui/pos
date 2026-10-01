/**
 * Маркеры карты уходят в кластер одним пакетом, попап строится при открытии
 * (аудит vedarai.ru 01.10: /map держал главный поток 4,9 с).
 *
 * markercluster режет добавление на порции (chunkedLoading) только в
 * addLayers; addLayer по одному пересчитывал кластеры 1500 раз подряд — и
 * так на каждом GPS-фиксе, потому что подпись маркера несёт расстояние.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('components/shared/LeafletMap.tsx', 'utf-8');

describe('отрисовка маркеров карты', () => {
  it('в кластер — одним addLayers, не по одному', () => {
    expect(SRC).toMatch(/cluster\.addLayers\(toCluster\)/);
    expect(SRC).not.toMatch(/cluster\.addLayer\(m\)/);
    expect(SRC).toMatch(/chunkedLoading: true/);
  });

  it('HTML попапа строится при открытии', () => {
    expect(SRC).toMatch(/m\.bindPopup\(\(\) => buildPopupHtml\(marker\), \{ maxWidth: 260 \}\)/);
  });
});
