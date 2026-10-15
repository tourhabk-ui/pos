/**
 * Строка действующего предупреждения для контекста Кузьмича (15.10).
 *
 * Зоны предупреждения шли в контекст слагами — «(avachinsky, eastern,
 * krai_commander)», — и модель могла повторить их человеку: слаг — ключ кода,
 * а не название места (lib/safety/zone-names.ts, то же правило, что у ленты
 * /safety). С 15.10 «юг края» Росгидромета и «по всему краю» МЧС несут ещё и
 * метки дальних округов, и слагов в строке стало больше. Человеку и модели —
 * имя зоны.
 */
import { zoneName } from '@/lib/safety/zone-names';

export interface AlertLineRow {
  title: string;
  description: string | null;
  severity: number;
  affected_zones: string[] | null;
}

const LEVEL = ['', 'INFO', 'ВНИМАНИЕ', 'ОПАСНОСТЬ'];

export function alertContextLine(r: AlertLineRow): string {
  const level = LEVEL[Math.min(r.severity, 3)] ?? 'ПРЕДУПРЕЖДЕНИЕ';
  const zones = r.affected_zones?.length ? ` (${r.affected_zones.map(zoneName).join(', ')})` : '';
  const desc = r.description ? `: ${r.description.slice(0, 150)}` : '';
  return `[${level}] ${r.title}${zones}${desc}`;
}
