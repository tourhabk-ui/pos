import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ELEMENT_GROUPS,
  EXCLUDED_TYPES,
  groupPlacesByElement,
  allElementTypes,
  knownLocationTypes,
  elementHref,
  getElementForType,
} from '@/lib/stats/element-groups';

describe('ELEMENT_GROUPS — маппинг выверен против реальных location_type', () => {
  it('ни одного фантомного типа: всё объявленное известно в LOCATION_TYPE_LABELS', () => {
    const known = new Set(knownLocationTypes());
    for (const t of allElementTypes()) {
      expect(known.has(t), `фантомный тип в стихиях: «${t}»`).toBe(true);
    }
  });

  it('каждый известный тип — РОВНО в одной стихии XOR в EXCLUDED (ничего не теряется молча)', () => {
    const inElement = new Set(allElementTypes());
    const inExcluded = new Set(EXCLUDED_TYPES);
    for (const t of knownLocationTypes()) {
      const a = inElement.has(t);
      const b = inExcluded.has(t);
      expect(a !== b, `тип «${t}»: должен быть либо в стихии, либо в EXCLUDED, ровно одно (a=${a}, b=${b})`).toBe(true);
    }
  });

  it('один тип не объявлен в двух стихиях', () => {
    const all = allElementTypes();
    expect(all.length).toBe(new Set(all).size);
  });

  it('стихий пять, у каждой непустой href', () => {
    expect(ELEMENT_GROUPS).toHaveLength(5);
    for (const g of ELEMENT_GROUPS) expect(g.href).toMatch(/^\/routes\?kind=place&location_type=/);
  });

  it('у каждой стихии непустой hex-цвет (карточки мест)', () => {
    for (const g of ELEMENT_GROUPS) {
      expect(g.color, `стихия «${g.key}» без цвета`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('getElementForType: тип стихии → группа с цветом, EXCLUDED и неизвестный → null', () => {
    expect(getElementForType('volcano')?.key).toBe('fire');
    expect(getElementForType('volcano')?.color).toMatch(/^#/);
    expect(getElementForType('glacier')?.key).toBe('snow');
    for (const t of EXCLUDED_TYPES) {
      expect(getElementForType(t), `EXCLUDED тип «${t}» не должен маппиться в стихию`).toBeNull();
    }
    expect(getElementForType('no_such_type')).toBeNull();
    expect(getElementForType(null)).toBeNull();
  });
});

describe('groupPlacesByElement — сумма сходится', () => {
  it('Σ(стихии) + excluded == Σ(вход); unmappedTypes пуст при известных типах', () => {
    const byType: Record<string, number> = {};
    knownLocationTypes().forEach((t, i) => { byType[t] = i + 1; });
    const { elements, excludedCount, unmappedTypes } = groupPlacesByElement(byType);
    const total = Object.values(byType).reduce((s, n) => s + n, 0);
    const elemSum = elements.reduce((s, e) => s + e.count, 0);
    expect(unmappedTypes).toEqual([]);
    expect(elemSum + excludedCount).toBe(total);
  });

  it('неизвестный тип попадает в unmappedTypes (сигнал рассинхрона)', () => {
    const { unmappedTypes } = groupPlacesByElement({ dragon_lair: 5, volcano: 2 });
    expect(unmappedTypes).toEqual(['dragon_lair']);
  });

  it('пустые стихии не показываются', () => {
    const { elements } = groupPlacesByElement({ volcano: 3 });
    expect(elements.map((e) => e.key)).toEqual(['fire']);
  });

  it('стихия суммирует все свои типы', () => {
    const { elements } = groupPlacesByElement({ bay: 2, cape: 1, island: 3, beach: 4 });
    const ocean = elements.find((e) => e.key === 'ocean');
    expect(ocean?.count).toBe(10);
  });

  it('elementHref ведёт в location_type-фильтр МЕСТ, а не в маршруты', () => {
    expect(elementHref('snow')).toBe('/routes?kind=place&location_type=mountain');
    expect(elementHref('ocean')).toBe('/routes?kind=place&location_type=bay');
    expect(elementHref('nature')).toBe('/routes?kind=place&location_type=lake');
    // Неизвестная стихия — тоже к местам: `/routes` увело бы в маршруты.
    expect(elementHref('unknown')).toBe('/routes?kind=place');
  });
});

/**
 * Ссылка с `location_type`, но без `kind=place`, — мёртвая (20.09).
 *
 * ── Что нашлось ───────────────────────────────────────────────────────────
 *
 * Владелец: «с главной сложно попасть на страницу мест». Попасть было
 * НЕЛЬЗЯ. Витрина `/routes` показывает умолчанием МАРШРУТЫ, и фильтр по типу
 * места при маршрутах отбрасывается обеими сторонами по построению: сервер —
 * `kind === 'place' ? location_type : ''`, клиент — `if (kind === 'place' &&
 * locationType)`. Значит адрес `/routes?location_type=volcano` открывает
 * полный список маршрутов без единого фильтра.
 *
 * Так вели ВСЕ пять плиток «Стихии» и три плитки «Истории сегодня». Ещё три
 * истории несли `category`, которую страница не читает вовсе — ни сервер, ни
 * клиент такого параметра не знают. Одиннадцать ссылок главной, одна
 * destination, и ни одна не доходила до мест: раздел был достижим только с
 * карточки уже открытого места, кнопкой «← Все места».
 *
 * ── Почему сторож смотрит на весь репозиторий ─────────────────────────────
 *
 * Исправить один файл мало: адрес короткий, вид у него правдоподобный, и
 * следующая копия напишется руками так же. Проверка идёт по исходникам и
 * ловит форму, а не место.
 */
describe('ссылки на витрину мест доходят до мест', () => {
  const ROOTS = ['app', 'components', 'lib'];

  function walkTsx(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkTsx(full, out);
      else if (/\.tsx?$/.test(full)) out.push(full);
    }
    return out;
  }

  /** Код без комментариев: разборы выше сами цитируют мёртвый адрес. */
  function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('ни одна ссылка не несёт location_type без kind=place', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walkTsx(join(process.cwd(), root))) {
        const code = codeOnly(readFileSync(file, 'utf-8'));
        for (const m of code.matchAll(/['"`](\/routes\?[^'"`]*location_type=[^'"`]*)['"`]/g)) {
          if (!m[1].includes('kind=place')) offenders.push(`${file.replace(process.cwd() + '/', '')}: ${m[1]}`);
        }
      }
    }
    expect(offenders, 'такой адрес открывает маршруты без фильтра').toEqual([]);
  });

  it('параметра category витрина не знает — ссылок с ним быть не должно', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walkTsx(join(process.cwd(), root))) {
        const code = codeOnly(readFileSync(file, 'utf-8'));
        for (const m of code.matchAll(/['"`](\/routes\?[^'"`]*\bcategory=[^'"`]*)['"`]/g)) {
          offenders.push(`${file.replace(process.cwd() + '/', '')}: ${m[1]}`);
        }
      }
    }
    expect(offenders, 'ни сервер, ни клиент этот параметр не читают').toEqual([]);
  });
});
