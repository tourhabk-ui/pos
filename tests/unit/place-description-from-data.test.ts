/**
 * Описание места пишется ИЗ ДАННЫХ, а не сочиняется.
 *
 * ── Случай 19.09 ───────────────────────────────────────────────────────────
 *
 * Владелец показал пост канала про Ключевскую сопку и спросил: «что за
 * сочинение, вулкан потухший». Пост оказался ни при чём — он дословно
 * перепечатал `places.description`. В базе лежало:
 *
 *   «К подножию Ключевской подходишь уже издали — он дышит... запах серы и
 *    остывающего камня... над головой курится вершина, где лава выходит
 *    наружу раз в несколько лет...»
 *
 * Сочинил это `POST /api/admin/enrich-places`. Модели давали имя, тип, район,
 * координаты и высоту — а в конце просили: «напиши описание так, БУДТО ТЫ
 * ТОЛЬКО ЧТО ВЕРНУЛСЯ ОТТУДА». Ни запаха, ни звука, ни частоты извержений в
 * этих данных нет. Требование, которое нечем выполнить, выполняется выдумкой
 * (CLAUDE.md §4.0) — тот же корень, что у «секрета места» в посте 19.08.
 *
 * ── Почему это не вопрос вкуса ─────────────────────────────────────────────
 *
 * Испорчен был не слог, а ЦЕНТРАЛЬНЫЙ ФАКТ. «Остывающий камень» и «лава раз в
 * несколько лет» описывают затухающий вулкан, а Ключевская — один из самых
 * активных на планете. Турист получал обратное представление об опасности
 * места на платформе, которая существует ради его безопасности.
 *
 * ── Что держит этот сторож ─────────────────────────────────────────────────
 *
 * Выдумку детерминированно не поймать — ловится ЗАКАЗ на неё: формулировка,
 * которая просит у модели то, чего ей не дали. Плюс две вещи, без которых
 * запрет остаётся словами: журнал происхождения (иначе на вопрос «сколько
 * описаний сочинено» снова нечем ответить) и отбор очереди, который не
 * заставляет дописывать короткий честный текст.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factsGiven } from '@/app/api/admin/enrich-places/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SRC = read('app/api/admin/enrich-places/route.ts');

/** Промпт — оба сообщения, system и user. */
function prompt(): string {
  const i = SRC.indexOf('function buildPrompt(');
  const j = SRC.indexOf('\n}', SRC.indexOf('role: \'user\'', i));
  expect(i, 'buildPrompt не найден').toBeGreaterThan(0);
  return SRC.slice(i, j);
}

describe('промпт не заказывает выдумку', () => {
  it('не просит писать «будто ты только что вернулся оттуда»', () => {
    // Дословная формулировка, которая сочинила Ключевскую.
    expect(prompt()).not.toMatch(/будто ты только что вернулся/i);
  });

  it('не просит личного опыта в любой формулировке', () => {
    // Список закрытый и узкий: широкий запрет по словам ловил бы объяснения.
    for (const ask of [/как будто ты/i, /ты был там/i, /от первого лица/i, /своими глазами/i]) {
      expect(prompt(), String(ask)).not.toMatch(ask);
    }
  });

  it('прямо велит писать только из данных', () => {
    expect(prompt()).toMatch(/ТОЛЬКО из данных/);
    expect(prompt()).toMatch(/Ничего не добавляй от себя/);
  });

  it('называет запрещённое поимённо: ощущения и непрошенные числа', () => {
    const p = prompt();
    expect(p).toMatch(/запах/i);
    expect(p).toMatch(/звук/i);
    expect(p).toMatch(/частот/i);
    expect(p).toMatch(/если они не даны|чего в данных нет/i);
  });

  it('разрешает короткий текст — это и есть исход «сказать нечего»', () => {
    // §4.0: пустая строка лучше придуманной. Требование объёма без источника
    // — то же принуждение, что и требование «секрета места».
    expect(prompt()).toMatch(/пиши КОРОЧЕ/i);
    expect(prompt()).not.toMatch(/250–450 символов/);
  });
});

describe('журнал происхождения ведётся', () => {
  it('описание пишется вместе с записью в description_provenance', () => {
    expect(SRC).toContain('INSERT INTO description_provenance');
    expect(SRC).toContain("'place'");
    expect(SRC).toContain('WRITER');
  });

  it('имя писателя одно на журнал и на отбор', () => {
    // Два написания разошлись бы молча, и роут начал бы переписывать то, что
    // сам же и написал.
    const writers = [...SRC.matchAll(/const WRITER = '([\w-]+)'/g)];
    expect(writers.length).toBe(1);
    expect(SRC).not.toMatch(/written_by = 'enrich/);
  });

  it('место без ark_id не выдаётся за записанное', () => {
    // Связать запись журнала не с чем — это отдельный исход, и он в логе.
    expect(SRC).toMatch(/нет ark_id, происхождение не записано/);
  });

  it('ни один отказ не глушится', () => {
    expect(SRC).not.toMatch(/catch\s*\{/);
    const errs = [...SRC.matchAll(/console\.error\('\[enrich-places\]/g)];
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('отбор не заставляет дописывать честное короткое', () => {
  it('место, уже описанное из данных, второй раз не берётся', () => {
    // Иначе замкнутый круг: короткий верный текст снова числится
    // «недописанным», и модель добирает знаки единственным доступным ей
    // способом — выдумкой.
    expect(SRC).toContain('description_provenance dp');
    expect(SRC).toMatch(/dp\.entity_id = p\.ark_id/);
  });

  it('защита не просто объявлена, а ВХОДИТ в условие отбора', () => {
    // Первая редакция этого сторожа искала `NOT EXISTS` в файле — и проходила
    // при снятой защите: константа оставалась объявленной, а из условия
    // уходила. Поймано подменой. Ровно «сторож, проверяющий объявление»
    // (§4): он зеленеет именно тогда, когда механизм отвалился.
    const cond = SRC.slice(SRC.indexOf('const condition = force'),
                           SRC.indexOf('const { rows: pending }'));
    expect(cond).toContain('${written}');
  });

  it('счёт и партия смотрят на ОДНО условие с одним алиасом', () => {
    // Два написания одного отбора разошлись бы молча: счёт показывал бы одно,
    // партия трогала другое.
    expect(SRC).toMatch(/FROM places p WHERE \$\{condition\}/);
    expect(SRC).toMatch(/FROM places p\b/);
  });

  it('force остаётся способом переписать заново', () => {
    expect(SRC).toMatch(/force\s*\n?\s*\?\s*'is_visible = true'/);
  });
});

describe('журнал записывает то, что реально дали модели', () => {
  it('список фактов один на промпт и на журнал', () => {
    // Запись «дано 5 фактов» при трёх в промпте хуже отсутствия записи:
    // она выглядит как проверка.
    expect(SRC).toContain('factsGiven(');
    expect(SRC).toContain('facts.length');
  });

  it('голое место даёт минимум фактов, богатое — больше', () => {
    const bare = factsGiven({
      description: null, location_type: 'volcano',
      zone: null, district: null, eco_zone: null, altitude_m: null,
    });
    expect(bare).toEqual(['тип объекта', 'координаты']);

    const rich = factsGiven({
      description: 'Прежний текст', location_type: 'volcano',
      zone: 'Восточная', district: 'Усть-Камчатский',
      eco_zone: 'UNESCO', altitude_m: 4750,
    });
    expect(rich).toContain('район');
    expect(rich).toContain('высота');
    expect(rich).toContain('охранный статус');
    expect(rich).toContain('прежнее описание');
    expect(rich.length).toBeGreaterThan(bare.length);
  });

  it('высота ниже порога фактом не считается — её не дают и модели', () => {
    const low = factsGiven({
      description: null, location_type: 'lake',
      zone: null, district: null, eco_zone: null, altitude_m: 40,
    });
    expect(low).not.toContain('высота');
  });

  it('пустое прежнее описание фактом не считается', () => {
    const blank = factsGiven({
      description: '   <p> </p>  ', location_type: 'lake',
      zone: null, district: null, eco_zone: null, altitude_m: null,
    });
    expect(blank).not.toContain('прежнее описание');
  });
});
