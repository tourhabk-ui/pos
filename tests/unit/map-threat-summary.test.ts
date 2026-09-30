/**
 * Сводка угроз на карте и пепел в зоне вулкана (#1428, решение владельца 30.09).
 *
 * 1. /map не отвечал на «что сейчас опасно в крае» — ответ жил на радаре
 *    /safety. Плашка берёт тот же safety-status, у неё три исхода, и
 *    «спокойно» из отсутствия данных она не рисует.
 * 2. Пепел оранжевого/красного вулкана знала только карточка вулкана; зона
 *    геофенса (карта и экран маршрута, офлайн) говорила «избегайте кратера».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapThreatSummary, ageLabel } from '@/lib/safety/map-threat-summary';
import { ashfallZoneNote, ASHFALL_RULES } from '@/lib/safety/ashfall-guidance';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('сводка угроз: три исхода', () => {
  it('тревоги есть — число и верхняя', () => {
    const s = mapThreatSummary({ hasAlert: true, activeCount: 3, topTitle: 'Паводок на р. Камчатка' });
    expect(s.state).toBe('alert');
    expect(s.label).toBe('3 тревоги в крае');
    expect(s.detail).toBe('Паводок на р. Камчатка');
  });

  it('склонение: 1 тревога, 5 тревог, 11 тревог, 21 тревога', () => {
    expect(mapThreatSummary({ activeCount: 1 }).label).toBe('1 тревога в крае');
    expect(mapThreatSummary({ activeCount: 5 }).label).toBe('5 тревог в крае');
    expect(mapThreatSummary({ activeCount: 11 }).label).toBe('11 тревог в крае');
    expect(mapThreatSummary({ activeCount: 21 }).label).toBe('21 тревога в крае');
  });

  it('источник ответил, тревог нет — спокойно', () => {
    expect(mapThreatSummary({ hasAlert: false, activeCount: 0 }).state).toBe('calm');
  });

  it('источник недоступен или ответа нет — «неизвестно», не «спокойно»', () => {
    expect(mapThreatSummary({ unavailable: true, hasAlert: false, activeCount: 0 }).state).toBe('unknown');
    expect(mapThreatSummary(null).state).toBe('unknown');
  });

  it('офлайн из кеша — возраст виден', () => {
    const s = mapThreatSummary({ hasAlert: false, activeCount: 0 }, 5 * 3_600_000);
    expect(s.state).toBe('calm');
    expect(s.detail).toBe('данные 5 ч назад');
    expect(ageLabel(30 * 60_000)).toBe('меньше часа назад');
    expect(ageLabel(50 * 3_600_000)).toBe('2 дн назад');
  });
});

describe('плашка на карте', () => {
  const chip = read('components/map/MapThreatChip.tsx');
  const map = read('app/map/_MapPageClient.tsx');

  it('подключена на /map и берёт общий источник', () => {
    expect(map).toMatch(/<MapThreatChip \/>/);
    expect(chip).toMatch(/fetch\('\/api\/public\/safety-status'\)/);
    expect(chip).toMatch(/mapThreatSummary\(/);
  });

  it('недоступный источник не затирает известный ответ в кеше', () => {
    expect(chip).toMatch(/if \(j\.data\.unavailable !== true\) writeCache\(j\.data\)/);
  });

  it('стекло по §2: тёмное, тревога — кромкой предупреждения', () => {
    expect(chip).toMatch(/className="fx-glass /);
    expect(chip).toMatch(/data-theme="dark"/);
    expect(chip).toMatch(/'alert' \? 'var\(--warning\)'/);
    expect(chip).not.toMatch(/bg-black\/40|backdrop-blur-md/);
  });
});

describe('пепел в зоне вулкана', () => {
  it('оранжевый/красный — строка о пепле, жёлтый/зелёный — нет', () => {
    expect(ashfallZoneNote('orange')).toMatch(/Выброс пепла вероятен/);
    expect(ashfallZoneNote('red')).toMatch(/Выброс пепла вероятен/);
    expect(ashfallZoneNote('yellow')).toBeNull();
    expect(ashfallZoneNote(null)).toBeNull();
  });

  it('строка не сочинена: опирается на правила справочника', () => {
    const note = ashfallZoneNote('red')!;
    expect(ASHFALL_RULES[0]).toMatch(/вдыхание пепла опасно для лёгких/);
    expect(note).toMatch(/вдыхание пепла опасно для лёгких/);
    expect(ASHFALL_RULES[1]).toMatch(/смоченную содовым раствором/);
    expect(note).toMatch(/смоченная содовым раствором/);
    expect(ASHFALL_RULES[4]).toMatch(/очках/);
  });

  it('роут геозон добавляет её к зоне вулкана', () => {
    const route = read('app/api/safety/geofence-zones/route.ts');
    expect(route).toMatch(/ashfallZoneNote\(row\.acc\)/);
  });
});
