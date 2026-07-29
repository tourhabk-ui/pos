/**
 * Ложная тревога на safety-платформе — тоже поломка.
 *
 * 28.07 пришёл КРИТ «safety-агент(ы) не отвечают» по danger-analysis и
 * sos-events-bridge. Оба крона в тот момент отрабатывали успешно: молчала не
 * платформа, а расписание GitHub Actions — у 30-минутного крона наблюдались
 * разрывы между прогонами до 3ч47м (227 мин) при пороге тревоги 150.
 *
 * Цена такой ошибки не нулевая. Красный алерт, который в половине случаев ни о
 * чём, обучает владельца не читать алерты — и следующий, настоящий, утонет
 * вместе с ложными. Поэтому молчание между порогами теперь ВНИМАНИЕ, а КРИТ —
 * только сверх верхнего порога, взятого с запасом от наблюдавшегося максимума.
 *
 * Проверяется по исходнику: checkDeadSafetyCrons ходит в базу, а утверждение
 * здесь — про пороги и формулировки, которые база не меняет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/watchdog.ts'), 'utf-8');

/** Комментарии не считаем: они как раз объясняют, что и почему изменено. */
const CODE = SRC.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

describe('молчание крона не выдаётся за отказ агента', () => {
  it('верхний порог КРИТ выше наблюдавшейся задержки GitHub', () => {
    const m = /SAFETY_CRON_CRITICAL_MIN\s*=\s*(\d+)/.exec(CODE);
    expect(m, 'верхнего порога нет — тревога снова одноуровневая').not.toBeNull();
    // Наблюдавшийся максимум штатной задержки — 227 мин. Порог обязан быть выше,
    // иначе ложный КРИТ вернётся при первой же такой задержке.
    expect(Number(m?.[1])).toBeGreaterThan(227);
  });

  it('нижний порог остаётся и он ниже верхнего', () => {
    const low = Number(/GITHUB_DELAY_FLOOR_MIN\s*=\s*(\d+)/.exec(CODE)?.[1]);
    const high = Number(/SAFETY_CRON_CRITICAL_MIN\s*=\s*(\d+)/.exec(CODE)?.[1]);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(high);
  });

  it('уровень решает длительность молчания, а не тип алерта', () => {
    // Пока safety_cron_dead стоит в списке безусловных КРИТ, флаг critical
    // ничего не решает и ВНИМАНИЕ недостижимо.
    const prefixLine = CODE.split('\n').find((l) => l.includes("? 'КРИТ:' : 'ВНИМАНИЕ:'"));
    expect(prefixLine, 'строка выбора префикса не найдена').toBeTruthy();
    expect(prefixLine).not.toContain('safety_cron_dead');
    expect(prefixLine).toContain('a.critical');
  });

  it('алерт говорит про прогон, а не про состояние агента', () => {
    // Liveness видит только отметку о последнем прогоне в agent_run_history и
    // не знает, отвечает агент или нет. Формулировка не должна утверждать
    // больше измеренного.
    expect(CODE).toContain('прогон не отмечался');
    expect(CODE).not.toContain('safety-агент(ы) не отвечают');
  });
});
