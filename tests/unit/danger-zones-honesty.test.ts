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
    expect(zoneBanner(true, ['low', 'low'])).toEqual({ state: 'calm', level: 'low', scope: null });
  });

  it('худшая зона поднимает тревогу и называется', () => {
    expect(zoneBanner(true, ['low', 'critical', 'moderate'])).toEqual({ state: 'alarm', level: 'critical', scope: null });
    expect(zoneBanner(true, ['low', 'moderate'])).toEqual({ state: 'alarm', level: 'moderate', scope: null });
  });

  it('действующее предупреждение не даёт объявить норму', () => {
    // Полевой скриншот владельца 10.08: шапка /safety вела зелёной плашкой
    // «Обстановка нормальная», а ниже на той же странице лежало предупреждение
    // МЧС о циклоне важности 2 на эту же ночь. Баннер считался только по
    // зонам и честно отвечал за свой источник — выдавая ответ за обстановку
    // целиком.
    const cyclone = [{ severity: 2 }];
    expect(zoneBanner(true, ['low', 'low'], cyclone).state).toBe('alarm');
    expect(zoneBanner(true, ['low', 'low'], cyclone).level).toBe('high');
  });

  it('тревога слышна и когда зоны неизвестны', () => {
    // Про зоны не знаем ничего, про циклон знаем. «Недоступно» здесь было бы
    // не скромностью, а умолчанием.
    expect(zoneBanner(false, [], [{ severity: 3 }])).toEqual({ state: 'alarm', level: 'critical', scope: 'по предупреждениям ниже' });
  });

  it('худшее из двух источников, а не последнее посчитанное', () => {
    // Зона хуже тревоги — побеждает зона.
    expect(zoneBanner(true, ['critical'], [{ severity: 1 }]).level).toBe('critical');
    // Тревога хуже зоны — побеждает тревога.
    expect(zoneBanner(true, ['moderate'], [{ severity: 3 }]).level).toBe('critical');
  });

  it('локальный алерт при низких зонах называет место, а не весь полуостров', () => {
    // Скриншот владельца 19.10: зоны 0–3 Normal, а шапка — голая «Высокая»
    // из-за запретов у отдельных вулканов. Уровень не занижаем, место называем.
    const volcanoes = [
      { severity: 2, title: 'Вулкан Мутновский: приближаться не рекомендуется' },
      { severity: 2, title: 'Вулкан Безымянный: приближаться не рекомендуется' },
      { severity: 2, title: 'Вулкан Ключевской: приближаться не рекомендуется' },
      { severity: 2, title: 'Мыс Левашова (п. Октябрьский): проезд запрещён' },
    ];
    const b = zoneBanner(true, ['low', 'low', 'low', 'low'], volcanoes);
    expect(b.state).toBe('alarm');
    expect(b.level).toBe('high');
    expect(b.scope).toContain('Мутновский');
    expect(b.scope).toContain('Безымянный');
    expect(b.scope).toContain('и ещё 2');
  });

  it('без алертов и при низких зонах баннер спокойный и без места', () => {
    expect(zoneBanner(true, ['low', 'low'], [])).toEqual({ state: 'calm', level: 'low', scope: null });
  });

  it('зональный высокий сигнал не теряется и называет зону', () => {
    const b = zoneBanner(
      true,
      ['low', 'critical'],
      [{ severity: 1, title: 'Вулкан Мутновский: приближаться не рекомендуется' }],
      ['Авачинско-Петропавловский', 'Северная Камчатка'],
    );
    expect(b).toEqual({ state: 'alarm', level: 'critical', scope: 'Северная Камчатка' });
    // severity 3 по предупреждению — тоже критический, с местом предупреждения.
    const ev = zoneBanner(true, ['low'], [{ severity: 3, title: 'Вулкан Шивелуч: эвакуация' }]);
    expect(ev.level).toBe('critical');
    expect(ev.scope).toContain('Шивелуч');
  });

  it('информационная тревога нормы не отменяет', () => {
    // severity 0 — сводка без угрозы. Красить из-за неё всю страницу значит
    // приучить не верить красному.
    expect(zoneBanner(true, ['low'], [{ severity: 0 }]).state).toBe('calm');
  });

  it('баннер получает ленту той же страницы, а не считается отдельно', () => {
    // Инвариант, ради которого всё: заголовок не может быть спокойнее
    // худшего сигнала, который страница показывает ниже.
    const SRC = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');
    // Последнее вхождение — вызов (первое это объявление). Смотрим окно
    // аргументов целиком: внутри есть свои скобки, и шаблон «до первой
    // закрывающей» обрывался на них.
    const call = SRC.slice(SRC.lastIndexOf('zoneBanner('));
    expect(call.slice(0, 200)).toContain('safety.alerts');
  });

  it('незнание никогда не окрашено как успех', () => {
    const SRC = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');
    // Конец окна — первый `return (` ПОСЛЕ объявления цвета: выше по файлу
    // стоят очистки эффектов (`return () => ...`), и поиск с начала файла
    // давал пустое окно — проверка молча переставала что-либо проверять.
    const from = SRC.indexOf('const bannerColor');
    const label = SRC.slice(from, SRC.indexOf('return (', from));
    // Цвет и подпись берутся из состояния баннера, а не из уровня риска
    // напрямую: именно прямое чтение уровня из пустого списка и давало зелень.
    expect(label).toMatch(/banner\.state === 'unknown'/);
  });
});
