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
 * Отбор туров на день ослаблен для Авачинской зоны осознанно —
 * `ark.zone = $1 OR $1 = 'avachinsky'`, то есть тур без записанной зоны
 * считается городским. Запрос занятости был СТРОГИМ (`ark.zone = $1`). Выходило,
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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  it('предикат зоны у занятости тот же, что у отбора туров на день', () => {
    const relaxed = DATA_CODE.match(/ark\.zone = \$1 OR \$1 = 'avachinsky'/g) ?? [];
    expect(relaxed.length, 'ослабление для Авачинской зоны не у обоих запросов')
      .toBeGreaterThanOrEqual(2);
  });

  it('строгий предикат в запросе занятости не вернулся', () => {
    expect(DATA_CODE, 'занятость снова считается строго по ark.zone')
      .not.toMatch(/WHERE ark\.zone = \$1\s/);
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
