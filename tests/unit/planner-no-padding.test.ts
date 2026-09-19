/**
 * Сторож: планировщик не добивает поездку копиями одного дня.
 *
 * ── Что было (замер с прода 19.09, MCP make_trip_plan) ───────────────────
 *
 * «Десять дней, интересы не назвал» возвращало план из восьми ОДИНАКОВЫХ
 * строк: «thermal — Авачинская зона — от 1 500 ₽». Механизм: интересы по
 * умолчанию — вулканы, медведи, термалка; в октябре первые два вне сезонных
 * окон, остаётся одна термалка; реальных туров и маршрутов в зоне не
 * нашлось; и цикл дней честно отработал восемь раз, каждый раз собрав ТОТ ЖЕ
 * общий день.
 *
 * Это ровно §4.0: место, где нельзя сказать «наполнить нечем», заполнилось
 * повтором. Восемь копий выглядят планом, планом не являясь — и хуже
 * короткого плана, потому что не дают повода усомниться.
 *
 * Сторож держит три вещи, каждая из которых чинилась отдельно:
 *   — общий день по паре «зона + активность» выдаётся один раз;
 *   — свободный день в городе — один, а не остаток поездки;
 *   — недобор называется словами, а не остаётся молчанием.
 * И четвёртую, мелкую, но видимую туристу: в заголовке дня не должно быть
 * ключа движка — «thermal» вместо «термальные источники».
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_NAMES, ACTIVITY_CONSTRAINTS } from '@/lib/planner';

const ENGINE = readFileSync(join(process.cwd(), 'lib/planner/engine.ts'), 'utf-8');

describe('имя активности для человека', () => {
  it('у каждого сезонного окна есть русское имя', () => {
    // Иначе ключ утечёт в заголовок дня ровно тогда, когда реального тура
    // не нашлось, — то есть в самом бедном плане, где это заметнее всего.
    for (const key of Object.keys(ACTIVITY_CONSTRAINTS)) {
      expect(ACTIVITY_NAMES[key], `нет имени для ${key}`).toBeTruthy();
    }
  });

  it('общий заголовок дня собирается из имени, а не из ключа', () => {
    expect(ENGINE).toMatch(/ACTIVITY_NAMES\[interest\] \?\? interest.*ZONE_NAMES\[block\.zone\]/);
    // Прежняя форма — голый ключ — не должна вернуться в КОД. В шапке
    // словаря она процитирована намеренно, как описание починенного.
    expect(ENGINE).not.toMatch(/title = [^\n]*\$\{interest\} — /);
  });

  it('словарь один на движок и на Кузьмича', () => {
    // Второй перевод тех же ключей разошёлся бы с первым (§10.09).
    const tool = readFileSync(join(process.cwd(), 'lib/kuzmich/trip-plan-tool.ts'), 'utf-8');
    expect(tool).toContain('ACTIVITY_NAMES');
    expect(tool).not.toMatch(/const INTEREST_NAME/);
  });
});

describe('движок не размножает день', () => {
  it('общий день по паре «зона + активность» выдаётся один раз', () => {
    expect(ENGINE).toContain('const genericDays = new Set<string>()');
    expect(ENGINE).toMatch(/const genericKey = `\$\{block\.zone\}:\$\{interest\}`/);
    expect(ENGINE).toMatch(/if \(genericDays\.has\(genericKey\)\) continue;/);
  });

  it('пропуск случается ТОЛЬКО когда нет ни тура, ни маршрута', () => {
    // Дублем считается пустой день, а не два выхода на один вулкан с
    // разными операторами: те — разные дни и обе брони настоящие.
    const guard = ENGINE.slice(ENGINE.indexOf('const genericKey') - 400, ENGINE.indexOf('const genericKey'));
    expect(guard).toContain('if (!realTour && !route)');
  });

  it('свободный день в городе — один, а не остаток поездки', () => {
    const idx = ENGINE.indexOf('Свободный день. Город');
    expect(idx).toBeGreaterThan(0);
    const before = ENGINE.slice(idx - 600, idx);
    // Раньше здесь стоял while, добивавший поездку копиями той же строки.
    expect(before).not.toMatch(/while \(dayNum <= tripDays - departureDays\)/);
    expect(before).toMatch(/if \(dayNum <= tripDays - departureDays\)/);
  });
});

describe('недобор назван словами', () => {
  it('план короче запрошенного даёт предупреждение', () => {
    expect(ENGINE).toMatch(/days\.length > 0 && days\.length < tripDays/);
    expect(ENGINE).toContain('Наполнили ${days.length}');
  });

  it('предупреждение не «инфо»: его нельзя проглотить фильтром', () => {
    // Кузьмич показывает предупреждения severity !== 'info'. Поставить сюда
    // info значило бы вернуть молчание другим способом.
    const block = ENGINE.slice(ENGINE.indexOf('Наполнили ${days.length}') - 600, ENGINE.indexOf('Наполнили ${days.length}'));
    expect(block).toContain("severity: 'important'");
  });

  it('называется причина, а не только число', () => {
    const at = ENGINE.indexOf('Наполнили ${days.length}');
    const block = ENGINE.slice(at - 700, at + 600);
    expect(block).toContain('вне сезона');
    // Список «вне сезона» строится из сезонных окон и переводится тем же
    // словарём — ключей движка турист видеть не должен и здесь.
    expect(block).toMatch(/months\.includes\(month\)/);
    expect(block).toContain('ACTIVITY_NAMES');
  });
});

describe('обещание страницы /plans держится сезоном', () => {
  const PAGE = readFileSync(join(process.cwd(), 'app/plans/[slug]/page.tsx'), 'utf-8');

  it('старт плана ищется в сезонном окне интересов пресета', () => {
    // Без этого «Камчатка за 7 дней: вулканы», пересобранная ISR в октябре,
    // показывала бы дни без единого вулкана — и теперь, когда движок не
    // добивает копиями, читатель увидел бы это глазами.
    expect(PAGE).toContain('ACTIVITY_CONSTRAINTS');
    expect(PAGE).toMatch(/months\.includes\(candidate\.getUTCMonth\(\) \+ 1\)/);
    expect(PAGE).toMatch(/planDates\(preset\.days, preset\.interests\)/);
  });
});
