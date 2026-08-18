/**
 * Молчание подряд краснит прогон.
 *
 * У дайджеста восемь законных выходов без публикации: нет свежих RSS, синтез
 * не удался, разделы пусты, проценты без источника, фактчек заглушил,
 * утверждения не подтверждены, близкий повтор, Telegram не принял. Каждый по
 * отдельности — осторожность, а не поломка.
 *
 * Но крон при этом возвращает успех. 1–8.08 это стоило недели тишины; тогда
 * починили половину — причину стали писать в журнал и называть в алерте
 * здоровья. 18.08 владелец показал скрин: «последний дайджест 2026-08-01
 * (17 дн назад)». Семнадцать дней при зелёных галочках каждый день.
 *
 * Значит названной причины мало: предупреждение в Telegram читают среди
 * других, а красный прогон в Actions требует ответа.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countLeadingSkips, silenceIsCritical, MAX_SILENT_RUNS } from '@/lib/agents/scout-silence';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/cron/scout-digest/route.ts');
const WORKFLOW = read('.github/workflows/cron-scout-digest.yml');

const ok = { status: 'success' };
const skip = { status: 'partial' };

describe('счёт молчаний идёт от свежего к старому', () => {
  it('до первого выпуска, дальше не считаем', () => {
    expect(countLeadingSkips([skip, skip, ok, skip, skip, skip])).toBe(2);
  });

  it('свежий выпуск обнуляет счёт', () => {
    expect(countLeadingSkips([ok, skip, skip])).toBe(0);
  });

  it('пустой журнал — ноль, а не тревога', () => {
    // «Не запускался ни разу» — другая беда, у неё свой сторож (liveness).
    expect(countLeadingSkips([])).toBe(0);
  });

  it('падение прогона тоже молчание: выпуска не было', () => {
    expect(countLeadingSkips([{ status: 'failed' }, skip, ok])).toBe(2);
  });
});

describe('порог терпит осторожность, но не систему', () => {
  it('один и два пропуска подряд прогон не красят', () => {
    // Фактчек-ворота законно срабатывают и два дня подряд. Красный за
    // честную осторожность отучил бы верить красному.
    expect(silenceIsCritical(0, false)).toBe(false);
    expect(silenceIsCritical(1, false)).toBe(false);
  });

  it('третий подряд — красный', () => {
    expect(silenceIsCritical(2, false)).toBe(true);
    expect(MAX_SILENT_RUNS).toBe(3);
  });

  it('ушедший выпуск снимает тревогу, каким бы ни было прошлое', () => {
    expect(silenceIsCritical(16, true)).toBe(false);
  });
});

describe('ответ крона несёт счёт, а прогон на него смотрит', () => {
  it('эндпоинт отдаёт число молчаний и вердикт', () => {
    expect(ROUTE).toMatch(/silent_runs/);
    expect(ROUTE).toMatch(/silence_critical/);
  });

  it('журнал читается ДО учёта текущего прогона', () => {
    // Свою строку прогон пишет фоново и к моменту ответа может там ещё не
    // появиться. Складывать «что было» и «что сейчас» надёжнее, чем ждать
    // собственной записи.
    expect(ROUTE).toMatch(/countLeadingSkips\(hist\.rows\)/);
    expect(ROUTE).toMatch(/silenceIsCritical\(silentRuns, result\.digest_sent\)/);
  });

  it('недоступный журнал не объявляется молчанием', () => {
    // Неизвестность — не тишина. Иначе сбой БД красил бы прогон агента.
    const guard = ROUTE.slice(ROUTE.indexOf('let silentRuns'), ROUTE.indexOf('const silent_runs'));
    expect(guard).toMatch(/catch/);
    expect(guard).toMatch(/silentRuns = 0/);
  });

  it('прогон краснеет и называет причину', () => {
    expect(WORKFLOW).toMatch(/silence_critical/);
    expect(WORKFLOW).toMatch(/::error::Разведчик молчит/);
    expect(WORKFLOW).toMatch(/digest_skip_reason/);
  });

  it('HTTP 200 больше не единственный признак успеха', () => {
    // Раньше строка была `[ "$HTTP" = "200" ] && echo OK` — и этим проверка
    // исчерпывалась.
    expect(WORKFLOW).toMatch(/exit 1/);
    expect(WORKFLOW).not.toMatch(/\[ "\$HTTP" = "200" \] && echo "OK"/);
  });
});
