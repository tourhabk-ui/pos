/**
 * Риск по зонам: либо посчитан, либо честно неизвестен. Третьего нет.
 *
 * Проба прода 10.08 вернула с /api/public/danger-summary ровно
 * `{"zones":[],"updatedAt":null}` — 29 байт. Ключ к разбору был в `updatedAt`:
 * в успешной ветке туда всегда писалось время, значит `null` мог прийти только
 * из `catch`. Запрос падал — роут селектил `updated_at`, а в таблице
 * `danger_assessments` (миграция 069) есть `assessed_at` и `created_at`, и
 * никогда не было `updated_at`.
 *
 * Дальше сбой шёл вверх молча: страница /safety при пустом списке зон не
 * рисует блок вовсе, а баннер обстановки брал максимум по пустому массиву,
 * получал `low` и объявлял «Обстановка нормальная» — зелёным, на странице
 * безопасности, не имея об этой обстановке ни одной цифры.
 *
 * Гард фантомных колонок это пропустил, и по своей причине: элемент
 * SELECT-списка с приведением типа (`assessed_at::text`) отбрасывался целиком
 * из-за двоеточия. Поэтому здесь три проверки — по одной на каждое звено
 * цепочки, и все три про свойство, а не про формулировку.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractColumnRefs, findPhantomRefs, buildSchemaRegistry } from '@/lib/database/schema-registry';
import { zoneBanner } from '@/app/safety/_SafetyClient';

describe('каст не прячет колонку от гарда', () => {
  it('col::text — такая же ссылка на колонку, как голый col', () => {
    const refs = extractColumnRefs('SELECT assessed_at::text FROM danger_assessments');
    expect(refs).toContainEqual({ table: 'danger_assessments', column: 'assessed_at' });
  });

  it('приведения любой формы не глушат разбор', () => {
    for (const cast of ['::text', '::TEXT', ':: timestamptz', '::text[]', '::double precision']) {
      const refs = extractColumnRefs(`SELECT risk_score${cast} FROM danger_assessments`);
      expect(refs, cast).toContainEqual({ table: 'danger_assessments', column: 'risk_score' });
    }
  });

  it('тот самый фантом ловится реестром миграций', () => {
    const reg = buildSchemaRegistry();
    const phantom = findPhantomRefs('SELECT updated_at::text FROM danger_assessments', reg);
    expect(phantom).toContainEqual({ table: 'danger_assessments', column: 'updated_at' });
    // И обратное: живая колонка фантомом не объявляется.
    expect(findPhantomRefs('SELECT assessed_at::text FROM danger_assessments', reg)).toEqual([]);
  });
});

describe('роут зон отличает сбой от пустоты', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/public/danger-summary/route.ts'), 'utf-8');

  it('на колонки, которых нет в миграциях, не ссылается', () => {
    expect(findPhantomRefs(SRC, buildSchemaRegistry())).toEqual([]);
  });

  it('возраст ответа берётся из данных, а не из часов сервера', () => {
    // `new Date()` в поле «когда обновлено» означает «свежее» всегда — даже
    // когда последней оценке сутки.
    expect(SRC).not.toMatch(/updatedAt:\s*new Date\(\)/);
    expect(SRC).toMatch(/assessed_at/);
  });

  it('упавший запрос не отдаётся как успешный', () => {
    // Клиент обязан иметь возможность различить: иначе «зон нет» и «зоны
    // неизвестны» приходят одним и тем же телом.
    expect(SRC).toMatch(/ok:\s*false/);
    expect(SRC).toMatch(/status:\s*5\d\d/);
  });
});

describe('баннер обстановки не выдаёт незнание за спокойствие', () => {
  it('оценки не получены — состояние неизвестно, а не «норма»', () => {
    expect(zoneBanner(false, []).state).toBe('unknown');
    // Даже если в теле что-то приехало: ok=false обесценивает содержимое.
    expect(zoneBanner(false, ['low']).state).toBe('unknown');
  });

  it('пустой список — тоже незнание: судить не по чему', () => {
    expect(zoneBanner(true, []).state).toBe('unknown');
  });

  it('спокойно — только когда все зоны реально посчитаны спокойными', () => {
    expect(zoneBanner(true, ['low', 'low'])).toEqual({ state: 'calm', level: 'low' });
  });

  it('худшая зона поднимает тревогу и называется', () => {
    expect(zoneBanner(true, ['low', 'critical', 'moderate'])).toEqual({ state: 'alarm', level: 'critical' });
    expect(zoneBanner(true, ['low', 'moderate'])).toEqual({ state: 'alarm', level: 'moderate' });
  });

  it('незнание никогда не окрашено как успех', () => {
    const SRC = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');
    const label = SRC.slice(SRC.indexOf('const bannerColor'), SRC.indexOf('return ('));
    // Цвет и подпись берутся из состояния баннера, а не из уровня риска
    // напрямую: именно прямое чтение уровня из пустого списка и давало зелень.
    expect(label).toMatch(/banner\.state === 'unknown'/);
  });
});
