/**
 * Разрез снятого трека по провалам сигнала (lib/field/track-segments.ts).
 *
 * «Зеленовские озерки» 31.08: 166 точек одним <trkseg>, внутри провалы на
 * 87 и 273 секунды; применение соединило их прямыми на 1.9 и 6.5 км —
 * зигзаг через Елизово. Владелец 02.09: «убери мусор и оставь только
 * нужный трек».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitAtGaps, pickSegment, describeBreak } from '@/lib/field/track-segments';
import { toGpx, emptyRecorder, SEGMENT_GAP_S, type RecorderState } from '@/lib/field/track-recorder';
import { parseTrackFile } from '@/lib/field/track-import';

const T0 = Date.UTC(2026, 7, 31, 6, 44, 37);

/** Ровный ход на север ~20 м/с: шаг 0.00018° широты в секунду. */
function run(n: number, lat0: number, lng0: number, t0: number): Array<{ lat: number; lng: number; t: number }> {
  return Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * 0.00018, lng: lng0, t: t0 + i * 1000 }));
}

describe('разрез по провалам', () => {
  it('провал по времени режет линию, куски названы с причиной', () => {
    const a = run(38, 53.214, 158.353, T0);
    const b = run(27, 53.230, 158.324, T0 + 38_000 + 87_000);
    const c = run(101, 53.292, 158.323, T0 + 38_000 + 87_000 + 27_000 + 273_000);
    const segs = splitAtGaps([...a, ...b, ...c]);
    expect(segs.map(s => s.points.length)).toEqual([38, 27, 101]);
    expect(segs[0]!.breakBefore).toBeNull();
    expect(segs[1]!.breakBefore?.reason).toBe('time_gap');
    expect(segs[1]!.breakBefore?.gapS).toBe(88);
    expect(segs[2]!.breakBefore?.gapS).toBe(274);
    expect(segs[2]!.from).toBe(65);
    expect(segs[2]!.to).toBe(165);
    expect(describeBreak(segs[2]!.breakBefore)).toMatch(/провал сигнала 274 с/);
  });

  it('без времени режет только по расстоянию, а честный перегон в час не режет', () => {
    const noTime = [
      { lat: 53.2, lng: 158.3, t: null }, { lat: 53.201, lng: 158.3, t: null },
      { lat: 53.26, lng: 158.3, t: null }, { lat: 53.261, lng: 158.3, t: null },
    ];
    expect(splitAtGaps(noTime).map(s => s.points.length)).toEqual([2, 2]);
    expect(splitAtGaps(noTime)[1]!.breakBefore?.reason).toBe('distance_jump');
    // 6.5 км за час — не провал, а перегон: время есть и пауза мала на каждом шаге.
    const slow = run(3600, 53.2, 158.3, T0);
    expect(splitAtGaps(slow)).toHaveLength(1);
  });

  it('pickSegment: all — вся линия, longest — самый длинный, число — по индексу', () => {
    const segs = splitAtGaps([...run(5, 53.2, 158.3, T0), ...run(9, 53.25, 158.3, T0 + 900_000)]);
    expect(pickSegment(segs, 'all')?.points).toHaveLength(14);
    expect(pickSegment(segs, 'longest')?.index).toBe(1);
    expect(pickSegment(segs, 0)?.points).toHaveLength(5);
    expect(pickSegment(segs, 7)).toBeNull();
    expect(pickSegment([], 'longest')).toBeNull();
  });

  it('ничего не сглаживает: точки куска — те же объекты в том же порядке', () => {
    const pts = run(10, 53.2, 158.3, T0);
    const seg = splitAtGaps(pts)[0]!;
    expect(seg.points).toEqual(pts);
  });
});

describe('рекордер пишет провал границей <trkseg>, а разбор читает время точек', () => {
  it('toGpx: пауза дольше SEGMENT_GAP_S открывает новый сегмент', () => {
    const st: RecorderState = {
      ...emptyRecorder(),
      points: [
        { lat: 53.2, lng: 158.3, altitude: 95, t: T0, accuracy: 5 },
        { lat: 53.2002, lng: 158.3, altitude: 95, t: T0 + 1000, accuracy: 5 },
        { lat: 53.23, lng: 158.32, altitude: 65, t: T0 + 1000 + (SEGMENT_GAP_S + 27) * 1000, accuracy: 5 },
        { lat: 53.2302, lng: 158.32, altitude: 65, t: T0 + 2000 + (SEGMENT_GAP_S + 27) * 1000, accuracy: 5 },
      ],
    };
    const gpx = toGpx(st, 'Проба');
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    const parsed = parseTrackFile(Buffer.from(gpx), 'proba.gpx');
    const pts = parsed.tracks[0]!.points;
    expect(pts).toHaveLength(4);
    expect(pts[0]!.t).toBe(T0);
    expect(pts[2]!.t).toBe(T0 + 1000 + (SEGMENT_GAP_S + 27) * 1000);
    // Разрез после разбора восстанавливает те же два куска.
    expect(splitAtGaps(pts).map(s => s.points.length)).toEqual([2, 2]);
  });

  it('точка без <time> — t: null, не ноль и не сейчас', () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>
      <trkpt lat="53.2" lon="158.3"><ele>10</ele></trkpt>
      <trkpt lat="53.21" lon="158.3"><ele>12</ele></trkpt>
    </trkseg></trk></gpx>`;
    const parsed = parseTrackFile(Buffer.from(gpx), 'x.gpx');
    expect(parsed.tracks[0]!.points.every(p => p.t === null)).toBe(true);
  });
});

describe('применение из очереди выбирает кусок и называет остальные', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/cron/track-import-queue/route.ts'), 'utf-8');
  const post = SRC.slice(SRC.indexOf('export async function POST'));

  it('segment по умолчанию all, reapply по умолчанию false', () => {
    // Схема тела объявлена выше POST — ищем по всему файлу.
    expect(SRC).toContain("segment: z.union([z.literal('all'), z.literal('longest'), z.number().int().min(0)]).default('all')");
    expect(SRC).toMatch(/reapply:\s*z\.boolean\(\)\.default\(false\)/);
  });

  it('куски печатаются всегда — и в сухом прогоне, и при отказе', () => {
    expect(post).toContain('splitAtGaps(plausible)');
    expect((post.match(/break_before: describeBreak/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(post).toContain('dropped_by_segment');
  });

  it('повторное применение — только applied и только с reapply', () => {
    expect(post).toMatch(/queued\.status !== 'pending' && !\(data\.reapply && queued\.status === 'applied'\)/);
  });
});
