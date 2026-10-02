/**
 * Утренний выпуск эволюции — по камчатскому времени (решение владельца 02.10:
 * «issues по расписанию в 7:30 по Камчатке»).
 *
 * Камчатка — UTC+12 без перехода на летнее время, значит 07:30 по Камчатке —
 * 19:30 UTC накануне. Цепочка: ревью (находит) → выпуск issues (заводит).
 * Выпуск идёт ПОСЛЕ ревью: иначе находки утреннего прогона ждали бы суток,
 * как было до 02.10 (ревью 05:50 UTC, выпуск 05:37 UTC — в обратном порядке).
 *
 * Сторож держит связку, а не одну строку: время в обоих workflow, порядок
 * между ними, и что ни один не попал в пик DeepSeek (§8).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPeakCronSlot } from '@/lib/ai/deepseek-peak';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Единственная расписательная строка файла: `- cron: 'M H * * *'`. */
function dailySlot(file: string): { minute: number; hour: number } {
  const crons = [...read(file).matchAll(/^\s*-\s*cron:\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+\*'/gm)];
  expect(crons.length, `${file}: ровно одно ежедневное расписание`).toBe(1);
  return { minute: Number(crons[0]![1]), hour: Number(crons[0]![2]) };
}

/** Минуты от полуночи по Камчатке (UTC+12). */
const kamchatkaMinutes = ({ minute, hour }: { minute: number; hour: number }) => ((hour + 12) % 24) * 60 + minute;

const review = dailySlot('.github/workflows/evo-review.yml');
const report = dailySlot('.github/workflows/evo-report.yml');

describe('утренний выпуск эволюции по Камчатке', () => {
  it('выпуск issues — около 07:30 по Камчатке', () => {
    const m = kamchatkaMinutes(report);
    expect(m).toBeGreaterThanOrEqual(7 * 60 + 20);
    expect(m).toBeLessThanOrEqual(7 * 60 + 40);
  });

  it('ревью идёт раньше выпуска, с запасом на его работу, но в то же утро', () => {
    const gap = kamchatkaMinutes(report) - kamchatkaMinutes(review);
    // Ревью считает ~1–2 минуты; GitHub может опоздать — запас 10–60 минут.
    expect(gap).toBeGreaterThanOrEqual(10);
    expect(gap).toBeLessThanOrEqual(60);
  });

  it('ни ревью, ни выпуск не стоят в пике DeepSeek и не на :00', () => {
    for (const slot of [review, report]) {
      expect(isPeakCronSlot(slot.hour, slot.minute)).toBe(false);
      expect(slot.minute).not.toBe(0);
    }
  });

  it('расписание описано теми же словами в workflow: Камчатка названа', () => {
    expect(read('.github/workflows/evo-review.yml')).toMatch(/07:11 по Камчатке/);
    expect(read('.github/workflows/evo-report.yml')).toMatch(/07:31 по Камчатке/);
  });
});
