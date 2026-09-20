/**
 * Проба Cache Storage — одна на весь офлайн-контур, и судит она строго.
 *
 * ── Повод (20.09) ─────────────────────────────────────────────────────────
 *
 * `lib/offline/coverage.ts` завёл честную проверку «сколько карты маршрута
 * лежит в телефоне» (PR #1979). Рядом при этом продолжали жить ДВЕ копии
 * того же приёма, и обе судили слабо:
 *
 *   useOfflineRegion.ts  проба [первый, средний, последний] + hits.some
 *   field-pack.ts        тот же hits.some по переданным адресам
 *
 * `some` значит «хоть один адрес на месте»: один уцелевший тайл из тысячи
 * читался как готовность, а при пробе из трёх адресов — две трети карты
 * могли быть вычищены, и полевой пакет проходил как готовый. Тройка вдобавок
 * не покрывала список: он идёт блоками по зумам, и целый зум между первым,
 * средним и последним не проверялся вовсе.
 *
 * Четвёртое место не судило вовсе: чек-лист готовности ставил галочку
 * «Маршрут сохранён офлайн» от записи в localStorage — то есть от памяти о
 * закачке, а не от её следов (это держит `checklist-truth`).
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 *  - поход в Cache Storage в офлайн-контуре живёт в одном файле;
 *  - прежний слабый предикат не вернулся ни к кому;
 *  - потребители различают «часть пропала» и «пропало всё» — иначе `partial`
 *    молча склеился бы с готовностью, как было до сведения;
 *  - запись о карте несёт, чем себя проверить, когда плана сервера нет.
 *
 * Поведение самой проверки (исходы, выборка, порог) держит `offline-coverage`
 * — здесь оно намеренно не повторяется.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/** Комментарии вырезаны: сторож не должен краснеть на словах о прежнем дефекте. */
const code = (src: string) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SOURCE = 'lib/offline/coverage.ts';
const CONSUMERS = [
  'lib/offline/useOfflineRegion.ts',
  'lib/offline/field-pack.ts',
  'app/planning/_PlanningClient.tsx',
];

describe('поход в хранилище — из одного файла', () => {
  it('caches.match в офлайн-контуре зовёт только модуль покрытия', () => {
    const offenders = readdirSync(join(process.cwd(), 'lib/offline'))
      .filter((f) => f.endsWith('.ts') && `lib/offline/${f}` !== SOURCE)
      .filter((f) => /caches\.match/.test(code(read(`lib/offline/${f}`))));
    expect(offenders, `своя проверка кэша: ${offenders.join(', ')}`).toEqual([]);
  });

  it('локальных копий sampleTilesPresent не осталось', () => {
    for (const f of CONSUMERS) {
      expect(code(read(f)), `${f}: копия правила вернулась`)
        .not.toMatch(/function\s+sampleTilesPresent/);
    }
  });

  it('каждый потребитель берёт проверку из общего файла', () => {
    for (const f of CONSUMERS) {
      expect(read(f), `${f}: не импортирует модуль покрытия`)
        .toContain("from '@/lib/offline/coverage'");
    }
  });

  it('своей выборки тройкой никто не собирает', () => {
    // Было: [urls[0], urls[Math.floor(urls.length / 2)], urls[urls.length - 1]]
    for (const f of CONSUMERS) {
      expect(code(read(f)), `${f}: тройка вернулась`)
        .not.toMatch(/urls\[Math\.floor\([^)]*length\s*\/\s*2\)\]/);
    }
  });
});

describe('предикат «хоть один на месте» не вернулся', () => {
  it('прежнего some нет ни у кого', () => {
    for (const f of CONSUMERS) {
      expect(code(read(f)), `${f}: предикат ослаблен до «хоть один»`)
        .not.toMatch(/hits\s*\.\s*some\s*\(/);
    }
  });

  it('регион: неполнота снимает «готово» наравне с пропажей', () => {
    expect(code(read('lib/offline/useOfflineRegion.ts')))
      .toMatch(/state === 'none' \|\| tiles\?\.state === 'partial'/);
  });

  it('полевой пакет: у неполной карты свой исход, а не готовность', () => {
    const src = code(read('lib/offline/field-pack.ts'));
    expect(src).toMatch(/present\.state === 'none'/);
    expect(src, 'partial снова склеен с готовностью').toMatch(/present\.state === 'partial'/);
  });

  it('пакет с неполной картой не считается готовым к полю', () => {
    // Страховка на случай, если `partial` начнут отдавать как `ready`:
    // неполный пакет, выданный за готовый, обнаруживается уже без связи.
    expect(code(read('lib/offline/field-pack.ts')))
      .toMatch(/tiles\.status === 'partial'\) return 'partial'/);
  });
});

describe('запись о карте несёт, чем себя проверить', () => {
  const SAVED = read('lib/offline/saved-map.ts');

  it('в записи есть проба адресов', () => {
    expect(SAVED).toMatch(/sampleUrls:\s*string\[\]/);
  });

  it('у записи без пробы поле пустое, а не выдуманное', () => {
    // Записи, сделанные до 20.09, пробы не несут. Пустая проба обязана дать
    // «проверить нечем», а не «карты нет».
    expect(code(SAVED)).toMatch(/Array\.isArray\(d\.sampleUrls\)/);
  });

  it('проба кладётся общей выборкой, а не своим выражением', () => {
    expect(code(read('app/planning/_PlanningClient.tsx')))
      .toMatch(/sampleUrls:\s*evenSample\(mapPlan\.urls,\s*SAVED_PROBE_SIZE\)/);
  });

  it('размер пробы назван константой — число в двух местах разошлось бы', () => {
    expect(SAVED).toMatch(/export const SAVED_PROBE_SIZE/);
  });

  it('шапка больше не обещает, что проверки наличия нет', () => {
    // Докстрока, описывающая несуществующее положение дел, — дефект кода
    // (§10.09), а не деталь документации.
    expect(SAVED).not.toContain('Проверка наличия — отдельный разговор');
  });

  it('чек-лист проверяет запись по её же пробе, без плана сервера', () => {
    // План приходит с сервера; без связи спросить было бы не о чем — то есть
    // ровно тогда, когда вопрос «а карта-то есть?» задают всерьёз.
    expect(code(read('app/planning/_PlanningClient.tsx')))
      .toMatch(/probeCoverage\(rec\.sampleUrls\)/);
  });
});
