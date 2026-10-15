/**
 * Память процесса Next в мегабайтах — для health (аудит 15.10, A21 и 1.15).
 *
 * Прод — 4 ГБ на контейнер (§6.1), и в том же процессе живёт локальная
 * модель поиска по смыслу (lib/ai/embeddings.ts). Решать, держать ли её там,
 * владелец будет по числам (апрель, 2.11), а чисел не было: health не говорил
 * о памяти ничего. rss — всё, что процесс занял у системы (с нативной памятью
 * ONNX), heap — куча V8.
 */

export interface ProcessMemoryMb {
  rss_mb: number;
  heap_mb: number;
  heap_total_mb: number;
  external_mb: number;
}

const MB = 1024 * 1024;

export function processMemoryMb(usage: NodeJS.MemoryUsage = process.memoryUsage()): ProcessMemoryMb {
  return {
    rss_mb: Math.round(usage.rss / MB),
    heap_mb: Math.round(usage.heapUsed / MB),
    heap_total_mb: Math.round(usage.heapTotal / MB),
    external_mb: Math.round(usage.external / MB),
  };
}
