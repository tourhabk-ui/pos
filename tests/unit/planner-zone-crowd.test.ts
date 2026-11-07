/**
 * Сторож: загрузка зоны — измеренное число, и «не измерено» отличимо от нуля.
 *
 * ── Что нашлось 27.09 ─────────────────────────────────────────────────────
 *
 * На экране плана у каждой зоны есть метка «загружено / умеренно». Потребитель
 * был, производителя не было: движок ставил `crowdScore: 0` литералом, и метка
 * (порог 50) не могла зажечься ни при какой заполненности. Ровно тот случай,
 * от которого предостерегает §10.09 — объявленный исход без источника.
 *
 * Занятость по зонам при этом СЧИТАЛАСЬ рядом (`fetchZoneCapacity`, реальные
 * брони из `v_tour_daily_occupancy`), штрафовала оценку зоны и терялась.
 *
 * ── Второй пласт: два запроса об одном отбирали разное ─────────────────────
 *
 * Отбор туров на день ослаблен для Авачинской зоны осознанно: тур без
 * записанной зоны считается городским (с 07.11 — `zoneMatchSql`, E4; до того
 * ослабление брало и туры чужих зон). Запрос занятости был СТРОГИМ (`ark.zone = $1`). Выходило,
 * что дни Авачинской зоны движок берёт из таких туров, а заполненность их не
 * считает никогда: локальный замер дал `null` при живой броне на 4 места из 10.
 * После выравнивания предиката тот же прогон дал 40.
 *
 * ── Третий исход ──────────────────────────────────────────────────────────
 *
 * Ноль значит «свободно» и только это. «Слотов на эти даты нет» и «запрос не
 * выполнился» — `null`, и метки тогда нет вовсе: молчание честнее «свободно»,
 * которого никто не проверял (§4.0).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { createPlannerCache, fetchRealToursForZone, fetchZoneCapacity } from '@/lib/planner/data';
import { zoneMatchSql } from '@/lib/planner/zone-match';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/**
 * Код без комментариев — включая SQL-комментарии `--` внутри шаблонных строк.
 *
 * Без них сторож обманывался: комментарий рядом с запросом занятости
 * пересказывает предикат словами, и подсчёт вхождений оставался прежним, даже
 * когда сам предикат возвращали к строгому. Проверка, которую не роняет
 * мутация, — не проверка.
 */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');
const DATA = read('lib/planner/data.ts');
const DATA_CODE = code(DATA);
const ENGINE = read('lib/planner/engine.ts');
const ENGINE_CODE = code(ENGINE);
const CLIENT = read('app/planner/_PlannerClient.tsx');
const CLIENT_CODE = code(CLIENT);

describe('у метки загрузки есть производитель', () => {
  it('движок пишет измеренную занятость, а не литерал', () => {
    expect(ENGINE_CODE).toMatch(/crowdScore: crowd\[zone as ZoneId\] \?\? null/);
    expect(ENGINE_CODE, 'захардкоженный ноль вернулся в crowdScore').not.toMatch(/crowdScore: 0/);
  });

  it('занятость зоны запоминается там же, где считается', () => {
    // Раньше она считалась, штрафовала оценку и терялась.
    expect(ENGINE_CODE).toMatch(/crowd\[zone\] = cap\.utilizationPercent/);
  });

  it('штраф зоны не срабатывает на «не измерено»', () => {
    // «Слотов на даты нет» — не то же, что «зона переполнена».
    expect(ENGINE_CODE).toMatch(/cap\.utilizationPercent !== null && cap\.utilizationPercent > 80/);
  });
});

describe('ноль отличим от «не измерено»', () => {
  it('тип допускает отсутствие', () => {
    expect(DATA).toMatch(/utilizationPercent: number \| null;/);
    expect(ENGINE).toMatch(/crowdScore\?: number \| null;/);
  });

  it('нет слотов — null, а не ноль', () => {
    expect(DATA_CODE).toMatch(/totalSlots > 0 \? Math\.round\(\(totalBooked \/ totalSlots\) \* 100\) : null/);
  });

  it('отказ запроса пишется в лог и отдаёт null, а не нули молча', () => {
    const at = DATA_CODE.indexOf('занятость зоны');
    expect(at, 'отказ занятости зоны не назван в логе').toBeGreaterThan(0);
    expect(DATA_CODE).toMatch(/SQLSTATE/);
    expect(DATA_CODE, 'отказ снова выдаётся за нулевую занятость')
      .not.toMatch(/catch \{\s*return \{ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 \};/);
  });
});

describe('два запроса об одном отбирают одно', () => {
  // Один предикат зоны — zoneMatchSql (lib/planner/zone-match): у отбора
  // туров на день, у заполненности зоны и у списка туров дня. Что он значит —
  // tests/unit/planner-zone-match.test.ts; здесь — что оба запроса движка
  // шлют именно его, а не свой.
  it('отбор туров на день и заполненность зоны шлют один и тот же предикат', async () => {
    const sql: string[] = [];
    poolQuery.mockImplementation(async (text: string) => { sql.push(text); return { rows: [] }; });
    const cache = createPlannerCache();
    await fetchRealToursForZone('avachinsky', 'volcano', 3, cache);
    await fetchZoneCapacity('avachinsky', '2030-07-01', '2030-07-07', cache);
    expect(sql).toHaveLength(2);
    for (const text of sql) expect(text).toContain(zoneMatchSql('ark', '$1'));
  });

  it('ни строгий, ни прежний ослабленный предикат не вернулись', () => {
    expect(DATA_CODE, 'занятость снова считается строго по ark.zone')
      .not.toMatch(/WHERE ark\.zone = \$1\s/);
    expect(DATA_CODE, 'Авачинская зона снова берёт туры любой зоны')
      .not.toMatch(/OR \$1 = 'avachinsky'/);
  });
});

describe('метка на экране не утверждает лишнего', () => {
  it('метка требует ЧИСЛА, а не «не undefined»', () => {
    // `!== undefined` пропускал бы null и показывал «свободно» там, где не
    // мерили: null > 50 ложно, но сравнение с null — уже утверждение о нём.
    expect(CLIENT_CODE).toMatch(/typeof z\.crowdScore === 'number' && z\.crowdScore > 50/);
    expect(CLIENT_CODE, 'метка снова судит по !== undefined').not.toMatch(/crowdScore !== undefined/);
  });

  it('пороги остались прежними: 50 — умеренно, 70 — загружено', () => {
    expect(CLIENT_CODE).toMatch(/z\.crowdScore > 70 \? 'загружено' : 'умеренно'/);
  });
});
