/**
 * Сводка Кузьмича на десктопной главной не заявляет того, чего не знает
 * (П8, аудит 24.09 #37; §4.0 — у проверки есть исход «не знаю»).
 *
 * Было: «обновлено ЧЧ:ММ» из часов браузера (время открытия страницы, а не
 * данных), зелёная «Норма» при safety = null и захардкоженный запасной
 * список мест вместо рекомендаций.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { briefingStatus, briefingUpdatedAt, BRIEFING_STALE_MS, type BriefingSafety } from '@/lib/home/briefing';

const NOW = new Date('2026-09-25T00:00:00Z');
const base: BriefingSafety = {
  hasAlert: false, maxSeverity: 0, activeCount: 0, topTitle: null, topType: null,
  dataUpdatedAt: '2026-09-24T23:00:00Z',
};

describe('статус сводки — четыре исхода, «не знаю» не равно «норма»', () => {
  it('нет данных → unknown', () => {
    expect(briefingStatus(null, NOW)).toBe('unknown');
    expect(briefingStatus(undefined, NOW)).toBe('unknown');
  });

  it('данные без времени (ingest ни разу не писал) → unknown', () => {
    expect(briefingStatus({ ...base, dataUpdatedAt: null }, NOW)).toBe('unknown');
    expect(briefingStatus({ ...base, dataUpdatedAt: 'не дата' }, NOW)).toBe('unknown');
  });

  it('данные старше порога → unknown', () => {
    const old = new Date(NOW.getTime() - BRIEFING_STALE_MS - 60_000).toISOString();
    expect(briefingStatus({ ...base, dataUpdatedAt: old }, NOW)).toBe('unknown');
  });

  it('свежие тихие данные → calm', () => {
    expect(briefingStatus(base, NOW)).toBe('calm');
  });

  it('тяжесть 2 → caution, 3 и выше → danger', () => {
    expect(briefingStatus({ ...base, hasAlert: true, maxSeverity: 2 }, NOW)).toBe('caution');
    expect(briefingStatus({ ...base, hasAlert: true, maxSeverity: 3 }, NOW)).toBe('danger');
  });
});

describe('время сводки — момент данных, не открытия страницы', () => {
  it('есть dataUpdatedAt → ЧЧ:ММ по Камчатке', () => {
    // 23:00 UTC = 11:00 следующего дня по Asia/Kamchatka (UTC+12)
    expect(briefingUpdatedAt(base)).toBe('11:00');
  });
  it('нет времени у данных → null, строки нет', () => {
    expect(briefingUpdatedAt(null)).toBeNull();
    expect(briefingUpdatedAt({ ...base, dataUpdatedAt: null })).toBeNull();
  });
});

describe('компонент KuzmichBriefing', () => {
  // Код без комментариев: шапка файла рассказывает историю словами прежних
  // заглушек, и сторож не должен путать рассказ с кодом.
  const SRC = readFileSync(join(process.cwd(), 'components/homepage/KuzmichBriefing.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('не берёт «обновлено» из часов браузера', () => {
    expect(SRC).not.toMatch(/new Date\(\)\.get(Hours|Minutes)/);
    expect(SRC).toMatch(/briefingUpdatedAt\(safety\)/);
  });

  it('«Норма» — только исход calm; у unknown свои слова', () => {
    expect(SRC).toMatch(/calm:\s*\{ label: 'Норма'/);
    expect(SRC).toMatch(/unknown:\s*\{ label: 'Обстановка неизвестна'/);
    expect(SRC).not.toMatch(/: 'Норма'\}/);
    expect(SRC).not.toMatch(/severity >= 2 \? [^:]+ : 'Норма'/);
  });

  it('захардкоженного запасного списка мест нет', () => {
    for (const name of ['Авачинский', 'Мутновский', 'Халактырский']) {
      expect(SRC).not.toContain(name);
    }
  });

  it('рекомендует туры из витрины страницы, а не свой подбор', () => {
    expect(SRC).toMatch(/\/marketplace\/tours\/\$\{t\.id\}/);
    expect(SRC).not.toMatch(/\/api\/safety\/routes/);
    const PAGE = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf-8');
    expect(PAGE).toMatch(/<KuzmichBriefing tours=\{plates\.filter\(\(p\) => p\.availability !== 'season_over'\)/);
  });
});

describe('текст сводки: «благоприятные» — только при calm', () => {
  const RAW = readFileSync(join(process.cwd(), 'components/homepage/KuzmichBriefing.tsx'), 'utf-8');
  it('каждое «Условия благоприятные» стоит под status === \'calm\'', () => {
    const hits = RAW.split('\n').filter((l) => l.includes('Условия благоприятные'));
    expect(hits.length).toBeGreaterThan(0);
    for (const line of hits) {
      expect(line, 'при unknown/устаревших данных сводка снова скажет «благоприятные»').toMatch(/status === 'calm'\)/);
    }
  });
});
