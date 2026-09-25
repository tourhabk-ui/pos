/**
 * Сторож: статус места — максимум по всем шкалам, включая вулканические (26.09).
 *
 * Внешняя сверка 26.09, подтверждена на проде через MCP: «Шивелуч (вулкан)
 * [ЗЕЛЁНЫЙ]», а строкой ниже — «KVERT: ОРАНЖЕВЫЙ — высокая активность. Пепел
 * до 12.0 км». Мутновский — [ЗЕЛЁНЫЙ] при жёлтом КФ ЕГС (242 события).
 * `recommender_status`, который читают карточка, маршруты, загрузка и
 * Кузьмич, считался по алертам и загрузке — коды вулканов в нём не
 * участвовали.
 *
 * Поведение SQL проверено на PostgreSQL 16 (26.09): оранжевый KVERT — red,
 * жёлтый КФ ЕГС — yellow, устаревшие коды не голосуют, алерт severity 2 —
 * red по-прежнему. Здесь держится форма, которая это даёт.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SRC = read('app/api/cron/safety-ingest/route.ts');
const FN = SRC.slice(SRC.indexOf('async function updateRealTimeStatus'), SRC.indexOf('async function dispatchPushAlerts'));

describe('recommender_status поднимается вулканическими шкалами', () => {
  it('функция найдена', () => {
    expect(FN.length).toBeGreaterThan(200);
  });

  it('обе шкалы читаются: KVERT и сводка КФ ЕГС', () => {
    expect(FN).toMatch(/FROM volcano_status vs/);
    expect(FN).toMatch(/FROM volcano_bulletin_kfegs b/);
  });

  it('оранжевый/красный — red, жёлтый — yellow (правило радара levelForColor)', () => {
    expect(FN).toMatch(/WHEN volc\.level >= 2 THEN 'red'/);
    expect(FN).toMatch(/WHEN volc\.level >= 1 THEN 'yellow'/);
    expect(FN).toMatch(/WHEN 'orange' THEN 2/);
  });

  it('красный по вулкану стоит до веток загрузки: пустое место под пеплом не зелёное', () => {
    const red = FN.indexOf("WHEN volc.level >= 2 THEN 'red'");
    const crowd = FN.indexOf('WHEN lrs.tourists_today >=');
    expect(red).toBeGreaterThan(0);
    expect(red).toBeLessThan(crowd);
  });

  it('устаревшая шкала не голосует — пороги из тех же констант, что у остальной платформы', () => {
    expect(FN).toMatch(/\[VOLCANO_STALE_DAYS, KFEGS_MAX_AGE_DAYS \+ 1\]/);
    expect(FN).toMatch(/vs\.observed_at > NOW\(\) - INTERVAL '1 day' \* \$1::int/);
    expect(FN).toMatch(/NOW\(\) - INTERVAL '1 day' \* \$2::int/);
  });
});

describe('дата наблюдения KVERT у Кузьмича — по Камчатке, как в get_volcano_status', () => {
  it('guardian-context печатает дату с timeZone Asia/Kamchatka', () => {
    const g = read('lib/kuzmich/guardian-context.ts');
    expect(g).toMatch(/volcano_observed_at\)\.toLocaleDateString\('ru-RU', \{ timeZone: 'Asia\/Kamchatka' \}\)/);
  });
});
