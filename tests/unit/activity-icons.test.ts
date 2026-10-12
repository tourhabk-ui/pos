// @vitest-environment node
/**
 * Значки активностей парны словарю подписей (владелец 12.10: «в турах,
 * наверное, иконку активностей — в данном случае это джип-тур»).
 *
 * Держит связку: у каждой подписи есть значок и у каждого значка — подпись
 * (новый тип без значка или значок-сирота — красный), джип-тур узнаётся
 * машиной, неизвестный тип получает общий значок, а блок «Туры по запросу»
 * берёт значок отсюда, а не рисует билет всем подряд.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Car, Fish, Helicopter, Ticket } from 'lucide-react';
import { ACTIVITY_ICONS, FALLBACK_ACTIVITY_ICON, activityIcon } from '@/lib/tours/activity-icons';
import { ACTIVITY_LABELS } from '@/lib/tours/labels';

describe('значки активностей', () => {
  it('ключи значков — ровно ключи подписей', () => {
    expect(Object.keys(ACTIVITY_ICONS).sort()).toEqual(Object.keys(ACTIVITY_LABELS).sort());
  });

  it('джип-тур — машина, рыбалка — рыба, вертолёт — вертолёт', () => {
    expect(activityIcon('jeep_safari')).toBe(Car);
    expect(activityIcon('fishing')).toBe(Fish);
    expect(activityIcon('helicopter')).toBe(Helicopter);
  });

  it('неизвестный тип и пустота — общий значок, не исключение и не пустота', () => {
    expect(activityIcon('zzz')).toBe(FALLBACK_ACTIVITY_ICON);
    expect(activityIcon(null)).toBe(Ticket);
    expect(activityIcon(undefined)).toBe(Ticket);
  });

  it('блок «Туры по запросу» берёт значок по типу, а не билет всем', () => {
    const src = readFileSync(join(process.cwd(), 'components/search/ToursForQuery.tsx'), 'utf-8');
    expect(src).toContain("from '@/lib/tours/activity-icons'");
    expect(src).toMatch(/const Icon = activityIcon\(t\.activity_type\)/);
    expect(src).not.toMatch(/<Ticket /);
  });
});
