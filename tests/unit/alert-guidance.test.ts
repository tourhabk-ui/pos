/**
 * Тревога без ответа на неё — половина работы, и худшая половина.
 *
 * Issue #1485: «Тревоги о вулкане и землетрясении формируются, но не доходят
 * ни до кого». Разбор 01.09: первая половина работает целиком — сейсмика из
 * USGS с привязкой зон по расстоянию, вулканы из КВЕРТ, пеплопад, крон
 * safety-alert, SafetyWarnings. Не работала вторая: офлайн-снимок нёс
 * `hasAlert`, `maxSeverity` и заголовок, то есть ЧТО случилось, а «что
 * делать» оставалось онлайн — недоступным именно там, где тревога и застаёт
 * человека.
 *
 * Здесь стерегутся черты, без которых починка снова станет декоративной.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  alertGuidance, guidedAlertTypes, NO_GUIDANCE_TEXT,
} from '@/lib/safety/alert-guidance';
import { ASHFALL_RULES } from '@/lib/safety/ashfall-guidance';

describe('справочник действий при тревоге', () => {
  it('типы из данных покрыты, а не выдуманные', () => {
    // Ключи должны совпадать с alert_type в external_alerts, иначе
    // руководство никогда не найдётся — и промах будет молчаливым.
    const covered = guidedAlertTypes();
    for (const t of ['volcano', 'earthquake', 'tsunami', 'avalanche', 'bear', 'flood', 'weather']) {
      expect(covered).toContain(t);
    }
  });

  it('пеплопад берётся из существующего справочника, а не переписан заново', () => {
    // Две копии правил МЧС разойдутся при первой же правке одной из них.
    expect(alertGuidance('volcano').steps).toBe(ASHFALL_RULES);
  });

  it('синонимы источников сводятся к одному руководству', () => {
    expect(alertGuidance('tsunami_warning').type).toBe('tsunami');
    expect(alertGuidance('ashfall').steps).toBe(ASHFALL_RULES);
    expect(alertGuidance('SEISMIC').type).toBe('earthquake');
  });

  it('неизвестный тип НЕ получает общих слов', () => {
    // «Будьте осторожны» на экране выглядит указанием, ничего не указывая, и
    // вытесняет собой поиск настоящего ответа (§4.0, третий исход).
    const g = alertGuidance('meteorite');
    expect(g.known).toBe(false);
    expect(g.steps).toEqual([]);
  });

  it('пустой тип — тоже «не знаю», а не молчаливое спокойствие', () => {
    expect(alertGuidance(null).known).toBe(false);
    expect(alertGuidance('').known).toBe(false);
    expect(alertGuidance(undefined).known).toBe(false);
  });

  it('отсутствие руководства называется словами и даёт 112', () => {
    expect(NO_GUIDANCE_TEXT).toMatch(/не записано/);
    expect(NO_GUIDANCE_TEXT).toContain('112');
  });

  it('шаги — действия, а не описания опасности', () => {
    // Признак: у каждого шага есть глагол в повелительном наклонении либо
    // прямое указание. Проверяем грубо — длину и отсутствие пустых строк,
    // чтобы сторож не превратился в спор о стилистике.
    for (const t of guidedAlertTypes()) {
      const steps = alertGuidance(t).steps;
      expect(steps.length).toBeGreaterThanOrEqual(3);
      for (const s of steps) {
        expect(s.trim().length).toBeGreaterThan(20);
      }
    }
  });
});

describe('руководство доезжает в офлайн', () => {
  const PACK = readFileSync(join(process.cwd(), 'lib/offline/field-pack.ts'), 'utf-8');
  const CLIENT = readFileSync(
    join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('снимок в пакете несёт шаги, а не только заголовок тревоги', () => {
    expect(PACK).toMatch(/guidance\?: readonly string\[\]/);
    expect(PACK).toMatch(/guidanceKnown\?: boolean/);
    expect(PACK).toMatch(/topType\?: string \| null/);
  });

  it('шаги кладутся при СБОРКЕ пакета — в поле сети не будет', () => {
    const at = CLIENT.indexOf('const assemblePack');
    expect(at).toBeGreaterThan(0);
    const body = CLIENT.slice(at, at + 2500);
    expect(body).toContain('alertGuidance(topType)');
    expect(body).toContain('guidance: g.steps');
  });

  it('живой снимок несёт то же самое — иначе «что делать» только у скачавших', () => {
    expect(CLIENT).toContain('alertGuidance(liveType)');
  });

  it('шаги показываются рядом с тревогой, а не прячутся в данные', () => {
    expect(CLIENT).toContain('Что делать');
    expect(CLIENT).toMatch(/snap\.guidance\.map/);
    expect(CLIENT).toContain('NO_GUIDANCE_TEXT');
  });

  it('руководство берётся из справочника, а не у модели', () => {
    // §8: критичные факты только из инструментов/БД, самоотчётам модели не
    // верить. Ни одного вызова AI на этом пути быть не должно.
    const G = readFileSync(join(process.cwd(), 'lib/safety/alert-guidance.ts'), 'utf-8');
    expect(G).not.toMatch(/callAI|fetch\(|openai|deepseek/i);
  });
});
