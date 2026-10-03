/**
 * /api/cron/places-osm-crosscheck — обещание «только читает».
 *
 * Инструмент сверки координат ничего не правит и не прячет сам: любая
 * находка идёт через POST /api/cron/place-coords (с независимым источником)
 * или отдельную миграцию-скрытие (без источника, как 947/948, 10.09). Этот
 * тест ловит попытку однажды добавить сюда write-путь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'app/api/cron/places-osm-crosscheck/route.ts'), 'utf-8');

describe('places-osm-crosscheck — только чтение', () => {
  it('GET и POST; POST принимает объекты OSM с раннера и проверяет их Zod (03.10)', () => {
    // POST — не запись: тело — данные для сравнения, выбранные на раннере,
    // потому что публичные Overpass перестали отдавать край проду.
    expect(SRC).toMatch(/export async function GET/);
    expect(SRC).toMatch(/export async function POST/);
    expect(SRC).not.toMatch(/export async function (PUT|PATCH|DELETE)/);
    expect(SRC).toContain('RunnerFeaturesSchema.safeParse(raw)');
    expect(SRC).toMatch(/\.max\(60_000\)/);
  });

  it('ответ говорит, откуда объекты OSM: спрошены продом или присланы раннером', () => {
    expect(SRC).toContain("osm_source: featuresSource ?? 'prod'");
  });

  it('нет ни одного write-запроса', () => {
    expect(SRC).not.toMatch(/UPDATE|INSERT INTO|DELETE FROM/);
  });

  it('авторизация — Bearer CRON_SECRET, постоянным временем', () => {
    expect(SRC).toContain('getCronSecret');
    expect(SRC).toContain('timingSafeCompare');
  });

  it('маркер версии для workflow есть', () => {
    expect(SRC).toMatch(/places_osm_crosscheck_v\d+/);
  });

  it('фильтр kind сужает список, но не подменяет общие счётчики (17.09)', () => {
    // kind — только буквы и подчёркивание: значение уходит в сравнение,
    // не в SQL, но и мусор в ответе лишний.
    expect(SRC).toMatch(/\/\^\[a-z_\]\{1,40\}\$\/\.test\(kindRaw\)/);
    expect(SRC).toMatch(/result\.items\.filter\(\(it\) => it\.locationType === kind\)/);
    // Отдельный счётчик по типу; общие items_with_candidates_total остаются
    // из result, а не из отфильтрованного списка.
    expect(SRC).toMatch(/items_kind_total: kind \? items\.length : null/);
    expect(SRC).toMatch(/items_with_candidates_total: result\.items\.length/);
  });
});

/**
 * Прогон 5 (20.09) вернул `{"success": false, "error": ...}` — роут отвечает
 * так при отказе Overpass, — а job остался ЗЕЛЁНЫМ.
 *
 * Печать в workflow брала ИМЕНОВАННЫЕ поля ответа, и при отказе все они
 * приходили пустыми: в лог ушла строка сплошных null, `error` с настоящей
 * причиной был выброшен, список мест был пуст. Читатель видел зелёную галочку
 * и пустоту — то есть «не смог» под видом «расхождений нет» (§4.0).
 *
 * Цена не теоретическая: по этому прогону я собирался судить 137 улик
 * переписи описаний. Пустой список означал бы «OSM ничего не подтвердил», а
 * на деле OSM не спросили вовсе.
 */
describe('прогон сверки не выдаёт отказ за успех', () => {
  const WF = readFileSync(join(process.cwd(), '.github/workflows/places-osm-crosscheck.yml'), 'utf-8');

  it('вердикт выносится по success, а не по тому, что json разобрался', () => {
    expect(WF).toContain("d.get('success') is not True");
  });

  it('при отказе прогон краснеет, а не идёт дальше', () => {
    const at = WF.indexOf("d.get('success') is not True");
    expect(at, 'проверки success в прогоне нет').toBeGreaterThan(0);
    expect(WF.slice(at, at + 600)).toContain('sys.exit(1)');
  });

  it('причина отказа ПЕЧАТАЕТСЯ, а не выбрасывается вместе с телом', () => {
    // Иначе следующий прогон начинается с гадания о том, что сломалось.
    const at = WF.indexOf("d.get('success') is not True");
    expect(WF.slice(at, at + 600)).toContain('json.dumps(d');
  });

  it('пустой ответ — «не смогли спросить», а не «расхождений нет»', () => {
    expect(WF).toContain('Сверка не ответила вовсе');
    expect(WF).toMatch(/if \[ -z "\$RESP" \]; then/);
  });

  it('неразобранный ответ показывается куском, а не глотается', () => {
    expect(WF).toContain('Ответ не разобрался как JSON');
  });
});

describe('выборка OSM — на раннере, сравнение — на проде (03.10)', () => {
  const WF = readFileSync(join(process.cwd(), '.github/workflows/places-osm-crosscheck.yml'), 'utf-8');
  const FETCH = readFileSync(join(process.cwd(), 'lib/geo/osm-overpass-fetch.ts'), 'utf-8');
  const SCRIPT = readFileSync(join(process.cwd(), 'scripts/osm-crosscheck-fetch.ts'), 'utf-8');

  it('workflow выбирает объекты скриптом и шлёт их POST-ом', () => {
    expect(WF).toContain('npx tsx scripts/osm-crosscheck-fetch.ts /tmp/osm-features.json');
    expect(WF).toContain('--data-binary @/tmp/osm-features.json');
    expect(WF.indexOf('osm-crosscheck-fetch.ts')).toBeLessThan(WF.indexOf('--data-binary'));
  });

  it('модуль сети не тянет пул БД: на раннере DATABASE_URL нет', () => {
    expect(FETCH).not.toMatch(/from '@\/lib\/db-pool'/);
    expect(SCRIPT).not.toMatch(/db-pool|lib\/database/);
  });

  it('скрипт: ноль объектов на весь край и непрочитанный квадрат — выход 1, не пустой файл', () => {
    expect(SCRIPT).toMatch(/features\.length === 0[\s\S]{0,300}return 1/);
    expect(SCRIPT).toMatch(/catch \(err\)[\s\S]{0,200}return 1/);
  });
});
