// @vitest-environment node
/**
 * Слияние маршрутов доносит поля, а не теряет их (04.09).
 *
 * До этого дня слияние переносило четыре вещи — геометрию, путевые точки,
 * туры и отметку `merged_into_id`. Остальное оставалось на скрытой записи, и
 * предупреждение честно об этом говорило; но человеку приходилось ВЫБИРАТЬ,
 * что потерять.
 *
 * Случай, который это вскрыл (проба 435, прод):
 *
 *   «Бабий камень»          паспорт visitkamchatka, телефон МЧС, 2 опасности,
 *                           описание 425 символов, ЛИНИИ НЕТ
 *   «Водопад Бабий камень»  снятый трек в 148 точек, описание 616 символов,
 *                           ни паспорта, ни МЧС, ни опасностей
 *
 * Ни одна запись не богаче другой. Любой выбор keep терял либо безопасность,
 * либо путь.
 *
 * Правило переноса — «заполнить только пустое, никогда не перезаписывать»,
 * а третий исход (у обоих заполнено по-разному) решает человек: склеить два
 * описания или выбрать один из двух телефонов МЧС автоматически нельзя (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  planFieldTransfer, isEmptyValue, pairWarnings, TRANSFER_FIELDS,
  type PairFacts,
} from '@/lib/routes/dedup';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/routes-dedup/route.ts'), 'utf-8');

/** Наш реальный случай, значениями с прода. */
const KEEP_WATERFALL = {
  pdf_url: null,
  source_url: 'https://idilesom.com/kam/places/1518',
  mchs_phone: null,
  hazards: '{}',
  description: 'x'.repeat(616),
};
const MERGE_PASSPORT = {
  pdf_url: 'https://visitkamchatka.ru/upload/route_passports/babiy_summer.PDF',
  source_url: 'https://visitkamchatka.ru/upload/route_passports/babiy_summer.PDF',
  mchs_phone: '+7 415 xxx',
  hazards: '{камнепад,река}',
  description: 'y'.repeat(425),
};

describe('пустота считается по типу колонки', () => {
  it('текст: null, пусто и пробелы', () => {
    expect(isEmptyValue(null, 'text')).toBe(true);
    expect(isEmptyValue('', 'text')).toBe(true);
    expect(isEmptyValue('   ', 'text')).toBe(true);
    expect(isEmptyValue('есть', 'text')).toBe(false);
  });

  it('массив: `{}` это пусто, а не значение', () => {
    expect(isEmptyValue('{}', 'array')).toBe(true);
    expect(isEmptyValue('{камнепад}', 'array')).toBe(false);
  });

  it('булево: NULL пусто, а false — ЗНАЧЕНИЕ', () => {
    // «регистрация не требуется» сказано так же явно, как «требуется»;
    // затирать это чужим true нельзя.
    expect(isEmptyValue(null, 'scalar')).toBe(true);
    expect(isEmptyValue('false', 'scalar')).toBe(false);
    expect(isEmptyValue('0', 'scalar')).toBe(false);
  });
});

describe('перенос: заполнить пустое, не трогать занятое', () => {
  const plan = planFieldTransfer(KEEP_WATERFALL, MERGE_PASSPORT);
  const filled = plan.fill.map(f => f.col);
  const conflicted = plan.conflicts.map(c => c.col);

  it('паспорт, телефон МЧС и опасности переезжают', () => {
    expect(filled).toContain('pdf_url');
    expect(filled).toContain('mchs_phone');
    expect(filled).toContain('hazards');
  });

  it('длинное описание keep не затирается коротким', () => {
    expect(filled).not.toContain('description');
    expect(conflicted).toContain('description');
  });

  it('source_url keep не трогается — он донор линии (§12)', () => {
    // У keep source_url указывает на idilesom, откуда пришёл трек. Правило
    // «только пустое» защищает происхождение линии само, без отдельной оговорки.
    expect(filled).not.toContain('source_url');
    expect(conflicted).toContain('source_url');
  });

  it('пустое у дубля не переносится ничем', () => {
    const plan2 = planFieldTransfer({ pdf_url: null }, { pdf_url: '   ' });
    expect(plan2.fill).toHaveLength(0);
    expect(plan2.conflicts).toHaveLength(0);
  });

  it('одинаковые значения у обоих — не конфликт и не перенос', () => {
    const same = planFieldTransfer({ mchs_phone: '112' }, { mchs_phone: '112' });
    expect(same.fill).toHaveLength(0);
    expect(same.conflicts).toHaveLength(0);
  });
});

describe('предупреждения называют и перенос, и конфликт', () => {
  const facts: PairFacts = {
    keepName: 'Водопад Бабий камень', mergeName: 'Бабий камень',
    keepGeometry: { present: true, source: 'external' },
    mergeGeometry: { present: false, source: null },
    mergeTours: 0, mergeHasPassport: true,
    transfer: planFieldTransfer(KEEP_WATERFALL, MERGE_PASSPORT),
  };
  const w = pairWarnings(facts).join(' | ');

  it('переезд назван словами, а не кодами колонок', () => {
    expect(w).toContain('официальный паспорт маршрута');
    expect(w).toContain('телефон МЧС');
  });

  it('конфликт описания вынесен человеку', () => {
    expect(w).toContain('решает человек');
    expect(w).toContain('описание');
  });

  it('без плана переноса предупреждение говорит «не рассчитан», а не молчит', () => {
    // «не переносили» и «нечего переносить» — разные вещи (§4.0).
    const noPlan = pairWarnings({ ...facts, transfer: undefined }).join(' | ');
    expect(noPlan).toContain('перенос не рассчитан');
  });
});

describe('запись в актуаторе не может перезаписать занятое', () => {
  it('сторож пустоты строится ПО ТИПУ колонки', () => {
    // Первая редакция писала везде IS NULL: пустой массив (`{}`, не NULL)
    // провалил бы условие, и при ANDе одна колонка отменила бы перенос всех
    // остальных молча.
    expect(ROUTE).toMatch(/cardinality\(k\.\$\{c\}\) = 0|cardinality\(k\.\$\{c\}\)/);
    expect(ROUTE).toMatch(/btrim\(k\.\$\{c\}\)/);
    expect(ROUTE).toMatch(/TRANSFER_FIELDS\.find/);
  });

  it('UPDATE ставит только колонки из fill и требует пустоты в WHERE', () => {
    expect(ROUTE).toMatch(/p\.transfer\.fill\.map\(f => f\.col\)/);
    expect(ROUTE).toMatch(/UPDATE kamchatka_routes k\n\s+SET \$\{sets\}/);
    expect(ROUTE).toMatch(/AND \(\$\{guards\}\)/);
  });

  it('ноль обновлённых строк не проходит молча', () => {
    expect(ROUTE).toMatch(/res\.rowCount === 0/);
    expect(ROUTE).toMatch(/transfer_skipped/);
  });

  it('план переноса виден в сухом прогоне', () => {
    expect(ROUTE).toMatch(/transfer,/);
    expect(ROUTE).toMatch(/planFieldTransfer\(sideValues\(r, 'keep'\), sideValues\(r, 'merge'\)\)/);
  });
});

describe('реестр полей', () => {
  it('служебные колонки в перенос не попадают', () => {
    const cols = TRANSFER_FIELDS.map(f => f.col);
    for (const forbidden of ['id', 'dedupe_key', 'metadata', 'is_visible', 'merged_into_id', 'geometry', 'title']) {
      expect(cols, forbidden).not.toContain(forbidden);
    }
  });

  it('у каждого поля есть человеческое имя — план читает человек', () => {
    for (const f of TRANSFER_FIELDS) expect(f.why.length, f.col).toBeGreaterThan(3);
  });
});
