/**
 * Сторож двух находок аудита 08.09 про SOS.
 *
 * Обе — про одно: отсутствие данных выдавалось за отсутствие угрозы.
 *
 *   1. `rescue-agency`: `LIMIT 20` стоял ДО фильтра активных. Двадцать свежих
 *      закрытых сигналов вытесняли старый активный, и сводка печатала
 *      «Активных SOS-инцидентов нет» — при живом неразрешённом сигнале.
 *   2. `danger-analyst-agency`: пустая выборка событий читалась как спокойная
 *      обстановка и могла отправить людям ОТБОЙ ТРЕВОГИ, даже если событий
 *      нет оттого, что приём тревог мёртв.
 *
 * Цена ошибки в этих двух местах не симметрична, и сторож держит именно
 * несимметричную сторону: молчать про активный SOS и звать назад под вулкан
 * нельзя, а лишний раз промолчать про отбой — можно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  calmIsTrustworthy,
  isStandDownTransition,
} from '../../lib/agents/agencies/danger-analyst-agency';

const RESCUE = readFileSync('lib/agents/agencies/rescue-agency.ts', 'utf8');
const DANGER = readFileSync('lib/agents/agencies/danger-analyst-agency.ts', 'utf8');

describe('активные SOS: фильтр до ограничения, а не после', () => {
  it('запрос активных отбирает по статусу, а не по последним двадцати', () => {
    // Проверяем ПРАВИЛО, а не буквальную строку: условие «сигнал висит»
    // теперь собрано из единственного словаря (lib/safety/sos-status.ts),
    // потому что написанное словами оно разошлось в четырёх местах и ни одно
    // не знало про статус 'archived'.
    expect(RESCUE).toContain('${SOS_ACTIVE_SQL}');
    expect(RESCUE).toContain("from '@/lib/safety/sos-status'");
  });

  it('тридцатидневного окна у активных нет: старый неразрешённый не прячется', () => {
    // Окно осталось только у статистики. У активных его быть не должно:
    // сигнал не перестаёт быть неразрешённым на тридцать первый день.
    const at = RESCUE.indexOf('WHERE ${SOS_ACTIVE_SQL}');
    const activeQuery = RESCUE.slice(Math.max(0, at - 700), at + 200);
    expect(activeQuery).not.toMatch(/INTERVAL '30 days'/);
  });

  it('счёт берётся ДО ограничения — усечение списка видно', () => {
    expect(RESCUE).toMatch(/COUNT\(\*\) OVER \(\)::int AS active_total/);
    expect(RESCUE).toContain('Показаны первые');
  });

  it('«активных нет» печатается по полному счёту, а не по длине списка', () => {
    expect(RESCUE).toMatch(/if \(activeTotal > 0\)/);
    expect(RESCUE).toContain('Активных SOS-инцидентов нет.');
  });

  it('активные старше окна называются отдельным числом', () => {
    // Именно они и пропадали раньше: в тридцатидневную статистику не входят.
    expect(RESCUE).toContain('activeOlderThanWindow');
    expect(RESCUE).toContain('Из них старше 30 дней');
  });

  it('фильтр по статусу в JS больше не применяется к урезанной выборке', () => {
    expect(RESCUE).not.toMatch(/recent\.rows\.filter/);
  });
});

describe('отбой тревоги: пустоте верим только при живом источнике', () => {
  it('события есть — свежесть приёма не при чём, судим как обычно', () => {
    expect(calmIsTrustworthy('dead', true)).toBe(true);
    expect(calmIsTrustworthy('never', true)).toBe(true);
    expect(calmIsTrustworthy('unknown', true)).toBe(true);
  });

  it('пусто и приём жив — «спокойно» заслужено', () => {
    expect(calmIsTrustworthy('alive', false)).toBe(true);
  });

  it('пусто и приём НЕ жив — права говорить «спокойно» нет', () => {
    // late тоже не даёт: отбой зовёт человека назад, и цена ошибки здесь
    // несимметрична. Лишний раз промолчать дешевле, чем позвать под вулкан.
    for (const status of ['late', 'dead', 'never', 'unknown'] as const) {
      expect(calmIsTrustworthy(status, false), `статус ${status}`).toBe(false);
    }
  });

  it('зона пропускается ЦЕЛИКОМ, а не только отбой', () => {
    // Записать сейчас risk_level 'low' — значит съесть переход high→low
    // навсегда: он считается ровно один раз, и настоящий отбой потом уже не
    // отправится никогда. Поэтому continue, а не пропуск одного push.
    expect(DANGER).toMatch(/if \(!calmIsTrustworthy\(ingest\.status, hasEvents\)\) \{/);
    const gate = DANGER.slice(DANGER.indexOf('if (!calmIsTrustworthy('));
    expect(gate.slice(0, 700)).toContain('continue;');
  });

  it('отказ назван вслух: и в ошибках прогона, и в логе', () => {
    expect(DANGER).toContain('обстановка не оценена');
    expect(DANGER).toMatch(/console\.error\('\[danger-analyst\]', why\)/);
  });

  it('живость берётся у cron-liveness, своего механизма нет', () => {
    expect(DANGER).toContain("from '@/lib/agents/cron-liveness'");
    expect(DANGER).toContain("from '@/lib/safety/ingest-run'");
    // Свежесть САМИХ тревог живостью источника не является: спокойная неделя
    // выглядит как мёртвый приём. Собственного порога тут быть не должно.
    expect(DANGER).not.toMatch(/MAX\(created_at\)[\s\S]{0,80}external_alerts/);
  });

  it('приём спрашивается один раз на прогон, а не по разу на зону', () => {
    const loopAt = DANGER.indexOf('for (const zone of ZONES)');
    expect(DANGER.indexOf('const lastIngest = await lastIngestAt();')).toBeLessThan(loopAt);
  });
});

describe('правило перехода осталось чистым', () => {
  it('переход считается только по двум соседним уровням', () => {
    expect(isStandDownTransition('high', 'low')).toBe(true);
    expect(isStandDownTransition('critical', 'moderate')).toBe(true);
    expect(isStandDownTransition('moderate', 'low')).toBe(false);
    // Оценок не было — переход посчитать не из чего, это не «спокойно».
    expect(isStandDownTransition(null, 'low')).toBe(false);
  });
});

/**
 * Две находки прогона 6 (08.09) по тем же файлам — и обе ДРУГИЕ, чем та,
 * что чинилась накануне. Журнал разобранного пометил совпадение по файлу и
 * отправил их в конец очереди, а не заглушил; глаза показали, что это новое.
 *
 *   1. «Среднее время реагирования» в сводке SOS было ЛИТЕРАЛЬНЫМ НУЛЁМ:
 *      `'0'::text AS avg_resolve_min`. Печаталось строкой «Среднее время
 *      реагирования: 0 мин.» и читалось как «реагируем мгновенно». В контуре,
 *      где висят живые сигналы, обязательное число было заполнено выдумкой.
 *
 *   2. Заглушка отказа провайдеров («сервис временно недоступен») уходила в
 *      сводку и сохранялась как заключение по зоне для оперативного штаба.
 */
describe('время реагирования считается, а не объявляется', () => {
  it('литерального нуля в запросе больше нет', () => {
    expect(RESCUE).not.toMatch(/'0'::text\s+AS avg_resolve_min/);
  });

  it('среднее берётся из настоящих отметок исхода', () => {
    expect(RESCUE).toMatch(/AVG\(EXTRACT\(EPOCH FROM \(outcome_at - created_at\)\) \/ 60\)/);
  });

  it('считается ТОЛЬКО по разрешённым человеком', () => {
    // unknown_no_response — «сутки никто не ответил». Включить его во время
    // реагирования значило бы выдать молчание за ответ.
    expect(RESCUE).toMatch(/FILTER \(WHERE outcome = 'resolved_by_human' AND outcome_at IS NOT NULL\)/);
  });

  it('нечего мерить — так и сказано, а не ноль', () => {
    expect(RESCUE).toContain('не измерено');
    expect(RESCUE).toMatch(/avg_resolve_min: string \| null/);
  });

  it('названо, по скольким сигналам посчитано', () => {
    // Среднее по одному сигналу и по сотне — разной цены утверждения.
    expect(RESCUE).toContain('measured_on');
  });
});

describe('заглушка отказа не выдаётся за разбор обстановки', () => {
  it('сводка спасателя сверяется с реестром заглушек', () => {
    expect(RESCUE).toContain('isWaterfallErrorResponse');
    expect(RESCUE).toContain("logSwallowedFailure('rescue-agency'");
  });

  it('оценка зоны не сохраняет заглушку как заключение', () => {
    expect(DANGER).toMatch(/if \(!text \|\| isWaterfallErrorResponse\(text\)\) return null;/);
  });

  it('когда разбора нет — это сказано словами, а счёт остаётся честным', () => {
    // Детерминированный балл остаётся: он настоящий. Врёт не он, а молчание,
    // выданное за заключение модели.
    expect(DANGER).toContain('Разбор моделью НЕ ПОЛУЧЕН');
    expect(DANGER).toContain('автоматическая оценка риска');
  });

  it('отказ разбора пишется в лог, а не глотается', () => {
    expect(DANGER).toContain("logSwallowedFailure('danger-analyst'");
    expect(DANGER).toContain('провайдеры молчат');
  });
});
