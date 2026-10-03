/**
 * Editor не записывает выдумку (решение владельца 03.10: «Editor не должен
 * выдумывать, только правду»).
 *
 * Проверяется поведение проверки и то, что ОБА пути записи — прод
 * (`runEditor`) и приёмник раннера (`/api/cron/editor-result`) — зовут её до
 * UPDATE. Сторож, проверяющий только функцию, зеленел бы при отключённой
 * проверке на любом из путей (§10.09: держать связку, а не половину).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { judgeGeneratedDescription, extractNumbers } from '@/lib/agents/editor-truth-gate';

const src = {
  title: 'Вулкан Авачинский',
  facts: ['тип объекта: volcano', 'высота над уровнем моря, м: 2741', 'координаты: 53.2550, 158.8300', 'опасности точки: камнепад'],
  previous: null,
};

describe('проверка правды', () => {
  it('текст только из источника — записывается', () => {
    const v = judgeGeneratedDescription('Вулкан Авачинский высотой 2741 метр. На склонах отмечен камнепад.', src);
    expect(v).toEqual({ ok: true, reasons: [] });
  });

  it('число не из источника — отказ', () => {
    const v = judgeGeneratedDescription('Подъём занимает 6 часов, высота 2741 метр.', src);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('6');
  });

  it('округлённая координата из источника не считается выдумкой, а чужое целое — считается', () => {
    expect(judgeGeneratedDescription('Координаты около 53.25 и 158.83.', src).ok).toBe(true);
    // 27 — не префикс-округление 2741: целые сравниваются целиком.
    expect(judgeGeneratedDescription('Высота около 27 метров.', src).ok).toBe(false);
  });

  it('пробел в тысячах и запятая в дробях нормализуются', () => {
    expect(extractNumbers('высота 2 741 м, кратер 0,4 км')).toEqual(['2741', '0.4']);
  });

  it('опасность не из источника — отказ; из источника — можно', () => {
    const bear = judgeGeneratedDescription('На склонах встречаются медведи.', src);
    expect(bear.ok).toBe(false);
    expect(bear.reasons.join(' ')).toContain('медведи');
    expect(judgeGeneratedDescription('Возможен камнепад.', src).ok).toBe(true);
  });

  it('ложное «безопасно» и «для новичков» — тоже выдумка о безопасности', () => {
    expect(judgeGeneratedDescription('Маршрут безопасен и подходит новичкам.', src).ok).toBe(false);
  });

  it('голос путевой заметки — отказ', () => {
    const v = judgeGeneratedDescription('Вчера я поднялся на вулкан Авачинский.', src);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toContain('путевая заметка');
  });

  it('ощущения без рассказчика — отказ', () => {
    expect(judgeGeneratedDescription('У вершины стоит тишина и запах серы.', src).ok).toBe(false);
  });

  it('рекламный эпитет — отказ', () => {
    expect(judgeGeneratedDescription('Незабываемый вулкан Авачинский.', src).ok).toBe(false);
  });

  it('«сел» как основа не ловит посёлок', () => {
    const s2 = { ...src, facts: [...src.facts, 'зона: посёлок Елизово'] };
    expect(judgeGeneratedDescription('Ближайший посёлок — Елизово.', s2).ok).toBe(true);
  });
});

describe('оба пути записи зовут проверку до UPDATE', () => {
  for (const file of ['lib/agents/editor.ts', 'app/api/cron/editor-result/route.ts']) {
    it(file, () => {
      const code = readFileSync(file, 'utf8');
      const judge = code.indexOf('judgeGeneratedDescription(');
      const update = code.indexOf('UPDATE agent_route_knowledge SET description');
      expect(judge).toBeGreaterThan(-1);
      expect(update).toBeGreaterThan(-1);
      expect(judge).toBeLessThan(update);
    });
  }
});
