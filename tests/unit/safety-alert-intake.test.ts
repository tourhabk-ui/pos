/**
 * У слоя предупреждений появился вход (23.08.2026).
 *
 * Повод живой: туристы не могут выехать с территории парка «Вулканы
 * Камчатки», проезд перекрыт. Владелец прислал сводку — и выяснилось, что
 * положить её платформе некуда.
 *
 * Таблица safety_alerts заведена миграцией 065 и ЧИТАЕТСЯ планировщиком:
 * предупреждения подмешиваются в рекомендации. Не писал её никто — ни ручка,
 * ни админка, ни крон. С момента создания пуста.
 *
 * То есть слой выглядел работающим и был мёртв: планировщик спрашивал «что
 * опасного в зоне», получал пустоту и рекомендовал маршруты так, будто ничего
 * не случилось. Тот же механизм, что весь день, но цена другая — не молчащий
 * дайджест, а человек, отправленный туда, откуда сейчас не выехать.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT_ZONES, ALERT_SEVERITIES } from '@/app/api/cron/safety-alert/route';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/safety-alert/route.ts'), 'utf-8');
const ENGINE = readFileSync(join(process.cwd(), 'lib/planner/engine.ts'), 'utf-8');
const MIGRATION = readFileSync(join(process.cwd(), 'migrations/065_safety_alerts.sql'), 'utf-8');

describe('вход в слой предупреждений существует', () => {
  it('умеет и публиковать, и снимать', () => {
    expect(ROUTE).toMatch(/INSERT INTO safety_alerts/);
    expect(ROUTE).toMatch(/UPDATE safety_alerts[\s\S]{0,120}is_active = FALSE/);
  });

  it('снятие не стирает строку — история решений сохраняется', () => {
    expect(ROUTE).not.toMatch(/DELETE FROM safety_alerts/);
    expect(ROUTE).toMatch(/reason/);
  });

  it('«не нашлось» и «уже снято» не выдаются за успех', () => {
    expect(ROUTE).toMatch(/rows\.length === 0/);
    expect(ROUTE).toMatch(/не найдено или уже снято/);
  });
});

describe('предупреждение несёт источник и срок', () => {
  it('источник обязателен — иначе это слух', () => {
    expect(ROUTE).toMatch(/source: z\.string\(\)/);
    expect(ROUTE).not.toMatch(/source:[^\n]*\.optional\(\)/);
  });

  it('срок обязателен как поле, но null — законный ответ', () => {
    // «До какого числа это верно» надо сказать вслух, а не забыть.
    expect(ROUTE).toMatch(/active_until: z\.string\(\)\.datetime\(\)\.nullable\(\)/);
    expect(ROUTE).not.toMatch(/active_until:[^\n]*\.default\(|active_until:[^\n]*\.optional\(\)/);
  });

  it('бессрочное предупреждение названо вслух в ответе', () => {
    expect(ROUTE).toMatch(/до ручного снятия/);
  });
});

describe('перечни берутся из схемы, а не выдумываются', () => {
  it('зоны совпадают с CHECK миграции 065', () => {
    for (const z of ALERT_ZONES) {
      expect(MIGRATION, `зона ${z} не объявлена в миграции`).toContain(`'${z}'`);
    }
  });

  it('уровни совпадают с CHECK миграции 065', () => {
    for (const s of ALERT_SEVERITIES) {
      expect(MIGRATION, `уровень ${s} не объявлен в миграции`).toContain(`'${s}'`);
    }
  });
});

describe('отказ чтения предупреждений не выдаётся за «всё спокойно»', () => {
  it('пустой catch в загрузчике планировщика не вернулся', () => {
    // Планировщик подмешивает предупреждения в рекомендации: «не смог
    // прочитать» здесь означало «в зоне спокойно».
    const at = ENGINE.indexOf('FROM safety_alerts');
    expect(at).toBeGreaterThan(0);
    const around = ENGINE.slice(at, at + 900);
    expect(around, 'отказ снова проглочен').not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*\s*)*return \[\];\s*\}/);
    expect(around).toMatch(/SQLSTATE/);
  });

  it('отказ логируется вместе с последствием', () => {
    expect(ENGINE).toMatch(/рекомендации строятся БЕЗ них/);
  });
});
