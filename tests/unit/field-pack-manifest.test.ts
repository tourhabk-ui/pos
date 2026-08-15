/**
 * Полевой пакет: готовность проверяемая, а не декларативная.
 *
 * План Field Confidence Navigator, этап 2. Инварианты:
 *  - partial никогда не выглядит как ready — ни в статусе ассета, ни в
 *    сводке пакета;
 *  - у снимка условий всегда виден возраст; старше суток — stale;
 *    «источник был недоступен» — missing, а не «условия спокойные»;
 *  - пакет привязан к редакции маршрута (routeVersion);
 *  - без сети линия маршрута поднимается из пакета — офлайн больше не
 *    теряет снятый трек.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  verifyFieldPack, fieldPackReadiness, formatSnapshotAge,
  SAFETY_SNAPSHOT_STALE_MS, type FieldPackManifest,
} from '@/lib/offline/field-pack';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const NOW = 1_700_000_000_000;

function manifest(over: Partial<FieldPackManifest> = {}): FieldPackManifest {
  return {
    routeId: 'r1',
    routeVersion: 2,
    title: 'Авачинский перевал',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    route: {
      track: [[53, 158], [53.01, 158.01]],
      trackDm: [0, 1500],
      geometrySource: 'idilesom',
    },
    waypoints: [{ lat: 53, lng: 158, name: 'Старт' }, { lat: 53.01, lng: 158.01, name: 'Перевал' }],
    tiles: {
      total: 100, failed: 0, droppedZooms: [], coverage: 'corridor',
      bufferKm: 2, mb: 24, sampleUrls: ['https://tile.openstreetmap.org/12/1/1.png'],
    },
    safety: { hasAlert: false, maxSeverity: 0, topTitle: null, source: 'КБГС РАН', at: NOW - 60_000, unavailable: false },
    storage: { persistent: true },
    ...over,
  };
}

// В node нет Cache Storage — sampleTilesPresent отвечает «проверить нечем»,
// и verify честно опирается на запись. Ветка «кэш вычищен» проверяется
// в поле, сторож держит остальную логику.

describe('partial никогда не зелёный', () => {
  it('нескачанные тайлы — partial, не ready', async () => {
    const states = await verifyFieldPack(manifest({
      tiles: { ...manifest().tiles!, failed: 7 },
    }), NOW);
    expect(states.find(s => s.kind === 'tiles')?.status).toBe('partial');
    expect(fieldPackReadiness(states)).toBe('partial');
  });

  it('отброшенные зумы — partial с честным словом', async () => {
    const states = await verifyFieldPack(manifest({
      tiles: { ...manifest().tiles!, droppedZooms: [15] },
    }), NOW);
    const tiles = states.find(s => s.kind === 'tiles');
    expect(tiles?.status).toBe('partial');
    expect(tiles?.note).toMatch(/грубее/);
  });

  it('целый пакет — ready', async () => {
    const states = await verifyFieldPack(manifest(), NOW);
    expect(fieldPackReadiness(states)).toBe('ready');
  });

  it('без карты пакет не готов; без точек — тем более', async () => {
    expect(fieldPackReadiness(await verifyFieldPack(manifest({ tiles: null }), NOW))).toBe('not_ready');
    expect(fieldPackReadiness(await verifyFieldPack(manifest({ waypoints: [] }), NOW))).toBe('not_ready');
  });
});

describe('снимок условий: возраст виден, недоступность не притворяется спокойствием', () => {
  it('свежий снимок — ready с возрастом', async () => {
    const s = (await verifyFieldPack(manifest(), NOW)).find(x => x.kind === 'safety_snapshot');
    expect(s?.status).toBe('ready');
    expect(s?.note).toMatch(/мин назад|только что/);
  });

  it('старше суток — stale', async () => {
    const s = (await verifyFieldPack(manifest({
      safety: { ...manifest().safety!, at: NOW - SAFETY_SNAPSHOT_STALE_MS - 1 },
    }), NOW)).find(x => x.kind === 'safety_snapshot');
    expect(s?.status).toBe('stale');
  });

  it('источник был недоступен — missing, не «спокойно»', async () => {
    const s = (await verifyFieldPack(manifest({
      safety: { ...manifest().safety!, unavailable: true },
    }), NOW)).find(x => x.kind === 'safety_snapshot');
    expect(s?.status).toBe('missing');
  });

  it('возраст форматируется по-человечески', () => {
    expect(formatSnapshotAge(NOW - 30_000, NOW)).toBe('только что');
    expect(formatSnapshotAge(NOW - 14 * 60_000, NOW)).toBe('14 мин назад');
    expect(formatSnapshotAge(NOW - 3 * 3_600_000, NOW)).toBe('3 ч назад');
  });
});

describe('линия у points_only — природа маршрута, не дефект пакета', () => {
  it('отсутствие трека — missing с честной формулировкой про точки', async () => {
    const states = await verifyFieldPack(manifest({
      route: { track: null, trackDm: null, geometrySource: null },
    }), NOW);
    const route = states.find(s => s.kind === 'route');
    expect(route?.status).toBe('missing');
    expect(route?.note).toMatch(/по точкам/);
    // Пакет при этом может быть готов: линии у маршрута нет по природе.
    expect(fieldPackReadiness(states)).toBe('ready');
  });
});

describe('пакет доехал до полевого экрана', () => {
  const client = read('app/planning/_PlanningClient.tsx');

  it('кнопка собирает пакет одним шагом (карта + линия + точки + условия)', () => {
    expect(client).toMatch(/assemblePack/);
    expect(client).toMatch(/saveFieldPack/);
    expect(client).toContain('Сохранить полевой пакет');
  });

  it('без сети линия поднимается из пакета', () => {
    expect(client).toMatch(/loadFieldPack\(routeId\)\.then\(pack/);
    expect(client).toMatch(/setTrack\(pack\.route\.track\)/);
  });

  it('состояние пакета на экране — из verifyFieldPack, с репетицией авиарежима', () => {
    expect(client).toMatch(/verifyFieldPack/);
    expect(client).toMatch(/fieldPackReadiness/);
    expect(client).toMatch(/авиарежим/);
  });

  it('пакет привязан к редакции маршрута', () => {
    expect(client).toMatch(/routeVersion: routeVersion \?\? 1/);
    expect(read('lib/offline/field-pack.ts')).toMatch(/routeVersion: number/);
  });
});
