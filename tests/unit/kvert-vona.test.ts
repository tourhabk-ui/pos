/**
 * tests/unit/kvert-vona.test.ts
 *
 * Парсер KVERT VONA (авиационные цветовые коды вулканов). Формат VONA —
 * стандарт ICAO с фиксированными полями, поэтому парсинг детерминирован.
 */

import { describe, it, expect } from 'vitest';
import {
  parseVona, parseVonaFeed, parseColor, normalizeVolcanoName, cleanVolcanoName, ACC_META,
} from '@/lib/services/safety/kvert-vona';

const VONA_RED = `VOLCANO OBSERVATORY NOTICE FOR AVIATION (VONA)

Issued: 20250807/2340Z
Volcano: Klyuchevskoy (CAVW #300260)
Current aviation color code: RED
Previous aviation color code: ORANGE
Source: KVERT
Notice Number: 2025-115
Volcano Location: N56 03 min E160 38 min
Area: Kamchatka, Russia
Summit Elevation: 4750 m
Volcanic Activity Summary: A lava fountaining continues.
Volcanic cloud height: 8000 m AMSL`;

const VONA_GREEN = `VOLCANO OBSERVATORY NOTICE FOR AVIATION (VONA)

Issued: 20250801/0000Z
Volcano: Avachinsky (CAVW #300100)
Current aviation colour code: GREEN
Previous aviation colour code: GREEN
Source: KVERT
Area: Kamchatka, Russia
Summit Elevation: 2741 m
Volcanic Activity Summary: No activity.`;

describe('parseColor', () => {
  it('распознаёт EN и RU цвета', () => {
    expect(parseColor('RED')).toBe('red');
    expect(parseColor('Orange')).toBe('orange');
    expect(parseColor('  yellow ')).toBe('yellow');
    expect(parseColor('GREEN')).toBe('green');
    expect(parseColor('жёлтый')).toBe('yellow');
    expect(parseColor('красный')).toBe('red');
  });
  it('не распознаёт мусор', () => {
    expect(parseColor('purple')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('cleanVolcanoName / normalizeVolcanoName', () => {
  it('убирает CAVW-код и регистр', () => {
    expect(cleanVolcanoName('Klyuchevskoy (CAVW #300260)')).toBe('klyuchevskoy');
  });
  it('мапит EN и RU алиасы на один slug + русское имя', () => {
    expect(normalizeVolcanoName('Klyuchevskoy')).toEqual({ slug: 'klyuchevskoy', ru: 'Ключевской' });
    expect(normalizeVolcanoName('Ключевской')).toEqual({ slug: 'klyuchevskoy', ru: 'Ключевской' });
    expect(normalizeVolcanoName('Sheveluch')).toEqual({ slug: 'sheveluch', ru: 'Шивелуч' });
  });
  it('неизвестный вулкан → null', () => {
    expect(normalizeVolcanoName('Vesuvius')).toBeNull();
  });
});

describe('parseVona', () => {
  it('парсит RED-бюллетень с полями', () => {
    const v = parseVona(VONA_RED)!;
    expect(v).not.toBeNull();
    expect(v.color).toBe('red');
    expect(v.previousColor).toBe('orange');
    expect(v.nameSlug).toBe('klyuchevskoy');
    expect(v.nameRu).toBe('Ключевской');
    expect(v.summitElevationM).toBe(4750);
    expect(v.ashHeightM).toBe(8000);
    expect(v.area).toContain('Kamchatka');
    expect(v.observedAt?.getUTCFullYear()).toBe(2025);
  });

  it('поддерживает британское colour и GREEN', () => {
    const v = parseVona(VONA_GREEN)!;
    expect(v.color).toBe('green');
    expect(v.nameSlug).toBe('avachinsky');
    expect(v.ashHeightM).toBeNull();
  });

  it('без обязательных полей → null', () => {
    expect(parseVona('Issued: 20250101/0000Z\nSource: KVERT')).toBeNull();
    expect(parseVona('Volcano: Klyuchevskoy\nSource: KVERT')).toBeNull(); // нет цвета
  });
});

describe('parseVonaFeed', () => {
  it('разбивает несколько бюллетеней и парсит каждый', () => {
    const feed = VONA_RED + '\n\n' + VONA_GREEN;
    const parsed = parseVonaFeed(feed);
    expect(parsed).toHaveLength(2);
    expect(parsed.map(p => p.color).sort()).toEqual(['green', 'red']);
  });
  it('пропускает нераспознанные блоки', () => {
    expect(parseVonaFeed('какой-то текст без VONA')).toEqual([]);
  });
});

describe('ACC_META', () => {
  it('severity растёт green→red', () => {
    expect(ACC_META.green.severity).toBeLessThan(ACC_META.yellow.severity);
    expect(ACC_META.yellow.severity).toBeLessThan(ACC_META.orange.severity);
    expect(ACC_META.orange.severity).toBeLessThan(ACC_META.red.severity);
  });
});
