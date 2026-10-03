/**
 * Выдуманная опасность не произносится как факт — и это правило, а не место.
 *
 * ── Что нашлось обходом экранов туриста 26.09 ────────────────────────────
 *
 * Слой безопасности мест завела миграция 070 (близнец 0645) ОДНИМ запросом по
 * всем записям, выводя значения из `location_type`:
 *
 *   CASE WHEN location_type = 'volcano'
 *        THEN ARRAY['avalanche','rockfall','thermal','altitude']
 *   CASE WHEN location_type = 'volcano' THEN 30   -- лимит посещения
 *   CASE WHEN location_type = 'volcano' THEN 4    -- сложность
 *
 * Дальше это расходилось по поверхностям КАК ФАКТ: бейджи «Что знать» на
 * карточке места, «Лимит посещения — 30 человек в сутки» рядом с высотой,
 * фразы Кузьмича, PDF, который человек берёт в поле, оценка риска у
 * инструмента безопасности. Счёт уже выставляли поимённо: 972-974 снимали с
 * Сопки Никольской — стометрового холма с городским парком — лавины,
 * камнепад, термальные поля и высотную болезнь.
 *
 * Отдельно — загрузка: `current_crowds` не пишет НИКТО, у всех строк стоял
 * DEFAULT 0, а единственный читатель отвечал на ноль зелёным «Свободно» рядом
 * со временем последней проверки тревог. Выдумка выглядела свежим измерением.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 *   1. поведение правила: `honestSafetyFields` вычищает РОВНО пять полей
 *      шаблона и не трогает остальные; `crowdsOnScale` не пускает ноль;
 *   2. миграция 1100 существует, размечает источник и снимает дефолты;
 *   3. КАЖДЫЙ файл, читающий шаблонные колонки из `location_safety_profile`,
 *      либо проходит через правило, либо записан в `KNOWN_RAW_READERS` с
 *      причиной. Список самоустаревающий: подключил файл правило — тест
 *      требует убрать запись (тот же приём, что у `KNOWN_UNPRODUCED` в
 *      `alert-types-produced`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAFETY_PROFILE_SOURCES,
  asProfileSource,
  crowdsOnScale,
  honestSafetyFields,
  mayStateAsFact,
} from '@/lib/safety/profile-source';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Колонки, которые выдумывал шаблон 070/0645. */
const TEMPLATED_COLUMNS = [
  'hazard_types',
  'capacity_per_day',
  'difficulty_level',
  'optimal_group_size',
  'terrain_type',
];

/**
 * Читатели, которые берут шаблонные колонки СЫРЫМИ — с причиной у каждого.
 *
 * Запись здесь не «разрешение навсегда», а названная причина. Часть из них
 * обязана видеть сырые данные (аудит, экспорт, разметка), часть — отдельная
 * задача, и её цену назовёт перепись `GET /api/cron/safety-profile-census`:
 * пока неизвестно, сколько мест за шаблоном, чинить наугад дороже, чем
 * записать долг словами.
 */
const KNOWN_RAW_READERS: Record<string, string> = {
  'app/api/cron/place-audit/route.ts':
    'аудит содержимого: обязан видеть то, что лежит в базе, иначе перестанет находить пробелы',
  'app/api/cron/places-export/route.ts':
    'выгрузка как есть для разбора; фильтровать здесь значило бы прятать пробелы от того, кто их чинит',
  'app/api/cron/safety-ingest/route.ts':
    'приём тревог считает по capacity_per_day порог переполнения; ветка опирается на tourists_today, у которого производителя нет вовсе, — разбор этой ветки отдельная задача',
  'app/api/safety/capacity/route.ts':
    'вместимость и группы: числа те же шаблонные, но экран отдельный — правится вместе с решением, чем заменить лимит (places.visitor_limit_per_day с источником, миграция 1017)',
  'app/api/safety/routes/route.ts':
    'скоринг радара безопасности: шаблонные опасности и сложность входят в оценку; менять формулу вслепую опаснее, чем оставить, пока перепись не назовёт долю',
  'app/api/routes/analysis/route.ts':
    'аналитика нагрузки COALESCE(capacity_per_day, 50) — внутренний отчёт, туристу не показывается',
  'lib/agents/editor.ts':
    'промпт переписывания описания тура: подаёт рельеф и опасности маршрута модели; нужна отдельная проверка, что чистка не обеднит текст',
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const SOURCES = [...routeFiles(join(process.cwd(), 'app/api')), ...routeFiles(join(process.cwd(), 'lib'))]
  .map((path) => ({ rel: path.replace(process.cwd() + '/', ''), code: readFileSync(path, 'utf-8') }))
  .filter((f) => f.code.includes('location_safety_profile'))
  .filter((f) => TEMPLATED_COLUMNS.some((c) => f.code.includes(c)));

describe('правило: шаблонное значение не произносится как факт', () => {
  it('источник читается только из известного словаря', () => {
    expect([...SAFETY_PROFILE_SOURCES]).toEqual(['type_template', 'manual', 'unknown']);
    expect(asProfileSource('type_template')).toBe('type_template');
    expect(asProfileSource('что-то новое')).toBeNull();
    expect(asProfileSource(null)).toBeNull();
  });

  it('произносить можно всё, кроме доказанного шаблона', () => {
    expect(mayStateAsFact('type_template')).toBe(false);
    expect(mayStateAsFact('manual')).toBe(true);
    expect(mayStateAsFact('unknown')).toBe(true);
    // Источник не записан — это не «шаблон», а «не знаем про него плохого».
    expect(mayStateAsFact(null)).toBe(true);
  });

  it('вычищаются РОВНО пять полей шаблона, остальные не тронуты', () => {
    const full = {
      hazardTypes: ['avalanche', 'rockfall'],
      capacityPerDay: 30,
      optimalGroupSize: 6,
      difficultyLevel: 4,
      terrainType: 'mountain',
      altitudeM: 1829,
      nearestMedicalKm: 75,
    };
    const honest = honestSafetyFields(full, 'type_template');
    expect(honest.hazardTypes).toEqual([]);
    expect(honest.capacityPerDay).toBeNull();
    expect(honest.optimalGroupSize).toBeNull();
    expect(honest.difficultyLevel).toBeNull();
    expect(honest.terrainType).toBeNull();
    // Высоту и расстояние до медпомощи шаблон не выдумывал — молчать о них
    // было бы своей выдумкой наоборот.
    expect(honest.altitudeM).toBe(1829);
    expect(honest.nearestMedicalKm).toBe(75);
    // Не шаблон — объект возвращается как есть, тем же значением.
    expect(honestSafetyFields(full, 'unknown')).toEqual(full);
    expect(honestSafetyFields(full, null)).toEqual(full);
  });

  it('загрузка: ноль и всё вне шкалы 1-5 — «не измеряли»', () => {
    expect(crowdsOnScale(0)).toBeNull();
    expect(crowdsOnScale(null)).toBeNull();
    expect(crowdsOnScale(12)).toBeNull();
    expect(crowdsOnScale(-1)).toBeNull();
    expect(crowdsOnScale(1)).toBe(1);
    expect(crowdsOnScale(5)).toBe(5);
    expect(crowdsOnScale('3')).toBe(3);
  });
});

describe('миграция 1100 размечает источник и снимает дефолты', () => {
  const sql = read('migrations/1100_safety_profile_source.sql');

  it('колонка источника и её словарь заведены', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS profile_source/);
    expect(sql).toMatch(/'type_template'/);
    expect(sql).toMatch(/location_safety_profile_source_known/);
  });

  it('отпечаток сверяется по ОБОИМ вариантам шаблона и по всем пяти полям', () => {
    // 0645 добавил ветки рыбалки, которых нет в 070: пропустить их значит
    // записать шаблонную строку как unknown и продолжить её показывать.
    expect(sql).toMatch(/activity_type = 'fishing'/);
    for (const col of ['capacity_per_day', 'optimal_group_size', 'difficulty_level', 'terrain_type', 'hazard_types']) {
      expect(sql, `отпечаток не сверяет ${col}`).toContain(`lsp.${col} =`);
    }
  });

  it('дефолты счётчиков сняты, шкала загрузки закреплена', () => {
    expect(sql).toMatch(/ALTER COLUMN current_crowds DROP DEFAULT/);
    expect(sql).toMatch(/ALTER COLUMN tourists_today DROP DEFAULT/);
    expect(sql).toMatch(/current_crowds BETWEEN 1 AND 5/);
  });
});

describe('каждый читатель шаблонных колонок проходит через правило или записан с причиной', () => {
  it('читатели найдены (пустой обход — отказ, а не успех)', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(10);
  });

  for (const { rel, code } of SOURCES) {
    it(rel, () => {
      const usesRule = code.includes('@/lib/safety/profile-source');
      const known = KNOWN_RAW_READERS[rel];
      if (usesRule) {
        // Самоустаревающий список: подключил правило — запись обязана уйти.
        expect(
          known,
          `${rel} уже проходит через правило — уберите его из KNOWN_RAW_READERS`,
        ).toBeUndefined();
        return;
      }
      expect(
        known,
        `${rel} читает шаблонные колонки сырыми: подключите lib/safety/profile-source или внесите файл в KNOWN_RAW_READERS с причиной`,
      ).toBeTruthy();
      expect(known!.length, `${rel}: причина слишком коротка, чтобы быть причиной`).toBeGreaterThan(30);
    });
  }

  it('в реестре нет записей про исчезнувшие файлы', () => {
    const seen = new Set(SOURCES.map((s) => s.rel));
    const stale = Object.keys(KNOWN_RAW_READERS).filter((rel) => !seen.has(rel));
    expect(stale, `KNOWN_RAW_READERS ссылается на файлы, которые больше не читают профиль: ${stale.join(', ')}`).toEqual([]);
  });
});
