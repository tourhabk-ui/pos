/**
 * Крон, который запускается и ничего не делает, должен быть виден.
 *
 * Сторож живости отвечал на один вопрос — «крон запускался». Весь июль поломки
 * платформы жили во втором, незаданном: «а сделал ли он что-нибудь». KVERT
 * возвращал fetched: 0 в день, когда Шивелуч дважды выбросил пепел (8 и 12 км),
 * и прогон был зелёным. Прочёс эволюции считал репозиторий из десяти файлов.
 * Шесть фидов разведки молчали при sources_ok: 6. Ни одну из этих поломок не
 * нашла платформа — все нашёл владелец, глазами.
 *
 * Судить по нулю можно не везде: ноль просроченных регистраций — хорошая
 * новость, ноль вулканов от KVERT — мёртвый слой. Разницу знает человек,
 * поэтому она объявляется явно, а тест следит, чтобы объявление не разъехалось
 * с реестром и чтобы «обязан работать» не стояло там, где работу не измеряют.
 */
import { describe, it, expect } from 'vitest';
import { CRON_REGISTRY, CRON_IDLE_MEANING, idleMeaning } from '@/lib/agents/cron-registry';
import { findIdleCrons, formatIdleCrons, IDLE_RUNS_THRESHOLD, type CronRunRow } from '@/lib/agents/cron-idle';

describe('объявления не разъезжаются с реестром', () => {
  it('у каждого крона реестра объявлено, что значит его ноль', () => {
    const undeclared = CRON_REGISTRY.filter((e) => !(e.key in CRON_IDLE_MEANING)).map((e) => e.key);
    expect(undeclared, 'новый крон обязан объявить смысл нуля осознанно').toEqual([]);
  });

  it('нет объявлений про кроны, которых уже нет в реестре', () => {
    const keys = new Set(CRON_REGISTRY.map((e) => e.key));
    const phantom = Object.keys(CRON_IDLE_MEANING).filter((k) => !keys.has(k));
    expect(phantom).toEqual([]);
  });

  it('«обязан работать» не ставится там, где нет телеметрии', () => {
    // agentId === null значит, что крон не пишет в agent_run_history вовсе:
    // тревожить по нулю, которого никто не измерял, — выдумка.
    const blind = CRON_REGISTRY
      .filter((e) => idleMeaning(e.key) === 'broken' && e.agentId === null)
      .map((e) => e.key);
    expect(blind).toEqual([]);
  });

  it('слой вулканов и оценка зон объявлены обязанными работать', () => {
    // Именно на них выгорел июль: оба тянут постоянно публикующий источник.
    expect(idleMeaning('kvert-acc')).toBe('broken');
    expect(idleMeaning('danger-analysis')).toBe('broken');
  });

  it('там, где ноль — хорошая новость, тревоги нет', () => {
    // Ноль просроченных регистраций, ноль проблем у сторожа, ноль коротких
    // описаний у редактора — это результат работы, а не её отсутствие.
    for (const key of ['watchdog', 'checkin-watchdog', 'editor', 'evo', 'health']) {
      expect(idleMeaning(key), key).toBe('normal');
    }
  });
});

describe('поиск холостых прогонов', () => {
  const entry = (key: string, agentId: string) =>
    CRON_REGISTRY.find((e) => e.key === key && e.agentId === agentId)!;

  const run = (agent_id: string, items: number | null, day: number): CronRunRow => ({
    agent_id,
    items,
    ended_at: `2026-07-${String(day).padStart(2, '0')}T07:00:00Z`,
  });

  it('три пустых прогона подряд — обрыв канала', () => {
    const rows = [run('kvert-acc', 0, 28), run('kvert-acc', 0, 27), run('kvert-acc', 0, 26), run('kvert-acc', 14, 25)];
    const idle = findIdleCrons([entry('kvert-acc', 'kvert-acc')], rows);
    expect(idle).toHaveLength(1);
    expect(idle[0].reason).toBe('idle');
    expect(idle[0].runs).toBe(IDLE_RUNS_THRESHOLD);
    expect(idle[0].lastProductiveAt).toContain('2026-07-25');
  });

  it('один пустой прогон тревогой не считается', () => {
    const rows = [run('kvert-acc', 0, 28), run('kvert-acc', 9, 27), run('kvert-acc', 11, 26)];
    expect(findIdleCrons([entry('kvert-acc', 'kvert-acc')], rows)).toEqual([]);
  });

  it('порядок строк не важен — сортируем сами', () => {
    const rows = [run('kvert-acc', 0, 26), run('kvert-acc', 12, 25), run('kvert-acc', 0, 28), run('kvert-acc', 0, 27)];
    expect(findIdleCrons([entry('kvert-acc', 'kvert-acc')], rows)).toHaveLength(1);
  });

  it('короткая история не судится: свежий крон не мёртвый', () => {
    const rows = [run('kvert-acc', 0, 28), run('kvert-acc', 0, 27)];
    expect(findIdleCrons([entry('kvert-acc', 'kvert-acc')], rows)).toEqual([]);
  });

  it('объявлен обязанным работать, но счётчик не пишет — тоже дефект', () => {
    // Молчание счётчика не равно «всё хорошо»: проверить нечем, и это надо
    // сказать вслух, а не считать здоровьем.
    const rows = [run('kvert-acc', null, 28), run('kvert-acc', null, 27), run('kvert-acc', null, 26)];
    const idle = findIdleCrons([entry('kvert-acc', 'kvert-acc')], rows);
    expect(idle[0].reason).toBe('no_metric');
  });

  it('кроны, где ноль штатен, не трогаем даже при длинной серии нулей', () => {
    const rows = [run('watchdog', 0, 28), run('watchdog', 0, 27), run('watchdog', 0, 26), run('watchdog', 0, 25)];
    expect(findIdleCrons(CRON_REGISTRY, rows)).toEqual([]);
  });

  it('на реальном реестре без истории тревог нет', () => {
    expect(findIdleCrons(CRON_REGISTRY, [])).toEqual([]);
  });

  it('сообщение называет крон и когда он последний раз что-то сделал', () => {
    const rows = [run('kvert-acc', 0, 28), run('kvert-acc', 0, 27), run('kvert-acc', 0, 26), run('kvert-acc', 3, 20)];
    const text = formatIdleCrons(findIdleCrons([entry('kvert-acc', 'kvert-acc')], rows));
    expect(text).toContain('KVERT ACC');
    expect(text).toContain('вхолостую');
    expect(text).toContain('20.07.2026');
  });
});
