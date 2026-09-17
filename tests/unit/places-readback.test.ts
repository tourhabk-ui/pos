/**
 * Сторож чтения обратно после заливки слоя мест (17.09).
 *
 * Владелец увидел в поле «Смотровую у Авачинского вулкана» — запись, скрытую
 * миграцией 950 неделю назад, — при зелёном прогоне заливки и чистом коде на
 * каждом звене, которое читается из репозитория. «Залито» значило только
 * «PutObject не бросил исключение»; файл после заливки не читал никто.
 *
 * Сторож держит чистую функцию сверки на фикстурах: три исхода (§4.0) —
 * совпало, не совпало, совпало-но-со-скрытым — и ни один не выдаётся за
 * другой. Отдельно — что скрипт заливки её действительно зовёт и что отказ
 * роняет прогон, а не пишет строку в лог.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyReadback, featureIds, parseExpectAbsent, sha256 } from '@/lib/map/places-readback';

const fc = (ids: string[]) => Buffer.from(JSON.stringify({
  type: 'FeatureCollection',
  features: ids.map((id) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [158.6, 53.0] }, properties: { id, name: id } })),
}));

const HIDDEN = '3cd79015-eed6-40ff-8e4c-eb49a8c7ff3a';

describe('три исхода сверки', () => {
  it('байты совпали, скрытых нет — ok с числом мест и sha', () => {
    const body = fc(['a', 'b']);
    const v = verifyReadback({ region: 'cell-53n158e', uploaded: body, fetched: Buffer.from(body), status: 200, expectAbsent: [HIDDEN] });
    expect(v).toEqual({ state: 'ok', features: 2, sha: sha256(body) });
  });

  it('хранилище отдало другое тело — mismatch с обоими sha и размерами', () => {
    const v = verifyReadback({ region: 'r', uploaded: fc(['a']), fetched: fc(['a', 'b']), status: 200, expectAbsent: [] });
    expect(v.state).toBe('mismatch');
    if (v.state === 'mismatch') expect(v.reason).toMatch(/не то, что заливали.*байт/);
  });

  it('байты совпали, но внутри скрытая запись — stale-content, а не ok', () => {
    // Это самый важный исход: хранилище честно, экспорт отдал скрытое.
    // Выдать его за ok значило бы повторить 11.09.
    const body = fc(['a', HIDDEN]);
    const v = verifyReadback({ region: 'r', uploaded: body, fetched: Buffer.from(body), status: 200, expectAbsent: [HIDDEN] });
    expect(v).toEqual({ state: 'stale-content', features: 2, presentAbsent: [HIDDEN] });
  });

  it('файл не прочитался — mismatch, не ok и не «пусто»', () => {
    const v = verifyReadback({ region: 'r', uploaded: fc(['a']), fetched: null, status: null, expectAbsent: [] });
    expect(v.state).toBe('mismatch');
  });

  it('не-200 от хранилища — mismatch с кодом', () => {
    const v = verifyReadback({ region: 'r', uploaded: fc(['a']), fetched: Buffer.from('x'), status: 403, expectAbsent: [] });
    expect(v.state).toBe('mismatch');
    if (v.state === 'mismatch') expect(v.reason).toMatch(/HTTP 403/);
  });

  it('совпавшие байты, но не FeatureCollection — mismatch', () => {
    const junk = Buffer.from('<html>');
    const v = verifyReadback({ region: 'r', uploaded: junk, fetched: Buffer.from(junk), status: 200, expectAbsent: [] });
    expect(v.state).toBe('mismatch');
  });
});

describe('вспомогательные', () => {
  it('featureIds читает id из properties и отбрасывает мусор', () => {
    expect(featureIds(fc(['x', 'y']))).toEqual(['x', 'y']);
    expect(featureIds(Buffer.from('нет'))).toBeNull();
    expect(featureIds(Buffer.from('{"type":"Feature"}'))).toBeNull();
  });

  it('parseExpectAbsent: пусто — пустой список, запятые и пробелы — чисто', () => {
    expect(parseExpectAbsent(undefined)).toEqual([]);
    expect(parseExpectAbsent('')).toEqual([]);
    expect(parseExpectAbsent(' a , b,,c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('скрипт заливки зовёт сверку и роняет прогон на отказе', () => {
  const SRC = readFileSync(join(process.cwd(), 'scripts/map-tiles/build-places.ts'), 'utf-8');
  const WF  = readFileSync(join(process.cwd(), '.github/workflows/map-places-build.yml'), 'utf-8');

  it('после каждой заливки — чтение обратно по адресу заливки', () => {
    expect(SRC).toMatch(/const res = await uploadToS3\(key, f\.body[\s\S]*?readBack\(f\.region, f\.body, res\.url, expectAbsent\)/);
  });

  it('чтение обратно идёт по тому же адресу, что и телефон, — с ?v=, без случайного buster', () => {
    // Адрес обязан совпадать с тем, что строит placesUrlFor: версия в нём
    // ЕСТЬ (17.09), а вот Date.now()/random — нет: со случайным хвостом
    // проверялось бы не то, что видит человек.
    expect(SRC).toMatch(/fetch\(`\$\{url\}\?v=\$\{PLACES_LAYER_VERSION\}`, \{ cache: 'no-store' \}\)/);
    expect(SRC).not.toMatch(/Date\.now\(\)|Math\.random\(\)/);
  });

  it('несовпадение и скрытые записи — код 1, не строка в логе', () => {
    expect(SRC).toMatch(/ЗАЛИВКА НЕ ПОДТВЕРЖДЕНА[\s\S]*?return 1;/);
    expect(SRC).toMatch(/ЭКСПОРТ ОТДАЛ[\s\S]*?return 1;/);
  });

  it('workflow пробрасывает expect_absent из маркера в скрипт', () => {
    expect(WF).toMatch(/expect_absent/);
    expect(WF).toMatch(/PLACES_EXPECT_ABSENT: \$\{\{ steps\.cfg\.outputs\.expect_absent \}\}/);
  });

  it('заливки идут по очереди, а не гонкой (17.09: два прогона на одни ключи)', () => {
    // Маркер в ветке и в main — два прогона одновременно на одни и те же
    // файлы хранилища; тело у каждого своё (экспорт помечает время), и
    // чтение обратно одного прогона ловит байты другого. Очередь без отмены:
    // второй прогон обязан дочитать своё, а не быть снятым.
    expect(WF).toMatch(/^concurrency:\n  group: map-places-build\n  cancel-in-progress: false$/m);
  });

  it('сводка прогона показывает исход сверки, а не только «залито»', () => {
    expect(WF).toMatch(/ЗАЛИВКА НЕ ПОДТВЕРЖДЕНА/);
    expect(WF).toMatch(/ЭКСПОРТ ОТДАЛ/);
  });
});
