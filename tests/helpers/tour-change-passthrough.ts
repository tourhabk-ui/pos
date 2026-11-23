/**
 * Подмена двери владельца прямой записью — для тестов, которые судят САМУ
 * запись полей тура (что уходит в UPDATE: закрепление, главное место,
 * программа, клипы), а базу подменяют одним клиентом.
 *
 * С 23.11 (план готовности, этап 4) владелец пишет тур через
 * lib/tours/tour-change: содержание опубликованного тура идёт черновиком на
 * проверку. Тур не на витрине пишется напрямую — этот случай подмена и
 * воспроизводит. Модерацию судит tests/integration/tour-moderation.pg.test.ts
 * на настоящем PostgreSQL; здесь её нет намеренно.
 */
import type { PoolClient } from 'pg';
import type { TourPatchInput } from '@/lib/tours/tour-write';

export function tourChangePassthrough() {
  return {
    saveTourChange: async (
      client: Pick<PoolClient, 'query'>,
      opts: { tourId: bigint | string; ownerId: string | null; input: TourPatchInput; current: Record<string, unknown> },
    ) => {
      const { writeTourPatch } = await import('@/lib/tours/tour-write');
      const w = await writeTourPatch(client, { tourId: opts.tourId, ownerId: opts.ownerId, input: opts.input, current: opts.current });
      return w.outcome === 'written' ? { outcome: 'written' as const, row: w.row, pending: null } : w;
    },
  };
}

/** Правок на проверке нет: форма показывает витрину как есть. */
export function noTourEdits() {
  return {
    loadOwnTourEdits: async () => new Map(),
    withdrawTourEdit: async () => 'none' as const,
  };
}
