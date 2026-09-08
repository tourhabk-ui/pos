/**
 * Два слепых пятна Watchdog. Оба — из «потерянных» находок аудита 08.09,
 * и оба про то, что сторож не видел именно там, где смотреть важнее всего.
 *
 * 1. ОБЩЕЕ ОКНО ИСТОРИИ. Три проверки кронов (idle, failing, fruitless) брали
 *    историю одним запросом с общим `ORDER BY ended_at DESC LIMIT N`.
 *    Комментарий над каждой обещал «с запасом по прогонам НА АГЕНТА» — SQL
 *    брал верхние N по ВСЕМ агентам сразу. Крон, идущий каждые полчаса, даёт
 *    48 строк в сутки, суточный safety-крон — одну; частые вытесняли редких,
 *    у редкого оставалось меньше порога строк, и все три чистые функции
 *    короткую историю МОЛЧА ПРОПУСКАЮТ. Чем реже крон — тем вернее он выпадал
 *    из наблюдения, а редкие у нас как раз safety.
 *
 * 2. СВИДЕТЕЛЬ СЕКРЕТА. Свежая запись ЛЮБОГО агента объявлялась
 *    доказательством, что CRON_SECRET и эндпоинт исправны, а виноват
 *    планировщик GitHub. Вывод не следует: в историю пишет и прогон, начатый
 *    человеком из админки (там admin-JWT, а не CRON_SECRET).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';
import {
  blameSilentCrons, describeBlame, witnessEligibleAgentIds, WITNESS_FRESH_MIN,
} from '@/lib/agents/cron-blame';

const WD = readFileSync('lib/agents/watchdog.ts', 'utf8');

describe('окно истории — на каждого агента отдельно', () => {
  it('есть одна общая точка выборки, а не три разных запроса', () => {
    expect(WD).toContain('async function fetchPerAgentHistory');
    expect(WD).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY agent_id ORDER BY ended_at DESC\)/);
    expect(WD).toMatch(/WHERE h\.rn <= \$2/);
  });

  it('все три проверки ходят через неё', () => {
    const calls = WD.match(/fetchPerAgentHistory</g) ?? [];
    // Объявление плюс три вызова.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(WD).toContain('fetchPerAgentHistory<CronRunRow>');
    expect(WD).toContain('fetchPerAgentHistory<CronStatusRow>');
    expect(WD).toContain('fetchPerAgentHistory<CronOutcomeRow>');
  });

  it('общего окна «число агентов × порог» больше нет', () => {
    // Именно оно и давало вытеснение редких кронов частыми.
    expect(WD).not.toMatch(/ids\.length \* \w+_RUNS_THRESHOLD/);
  });
});

describe('свидетель секрета: только тот, кого нельзя запустить руками', () => {
  it('годные отбираются по triggerable, а не берутся все подряд', () => {
    const ids = witnessEligibleAgentIds(CRON_REGISTRY);
    expect(ids.length).toBeGreaterThan(0);
    for (const e of CRON_REGISTRY) {
      if (e.agentId === null) continue;
      if (e.triggerable) expect(ids, `${e.key} запускается руками`).not.toContain(e.agentId);
    }
  });

  it('среди годных есть частые — окно в час не пустует', () => {
    const ids = new Set(witnessEligibleAgentIds(CRON_REGISTRY));
    const frequent = CRON_REGISTRY.filter(
      (e) => e.agentId !== null && ids.has(e.agentId) && e.everyMin <= WITNESS_FRESH_MIN,
    );
    expect(frequent.length, 'иначе свидетеля не найти никогда').toBeGreaterThan(0);
  });

  it('запрос свидетеля сужен списком годных', () => {
    expect(WD).toContain('witnessEligibleAgentIds(CRON_REGISTRY)');
    expect(WD).toMatch(/agent_id = ANY\(\$1\)[\s\S]{0,80}GROUP BY agent_id/);
  });

  it('свидетеля нет — вердикт «не смог», и виноватого не называют', () => {
    const b = blameSilentCrons(null, 240);
    expect(b.kind).toBe('unknown');
    const text = describeBlame(b);
    expect(text).toContain('Виноватого не называю');
    expect(text).toContain('запуски из админки свидетелями не считаются');
  });

  it('свежий годный свидетель — виноват планировщик, и сказано почему', () => {
    const b = blameSilentCrons({ agentId: 'safety-ingest', minutesAgo: 4 }, 300);
    expect(b.kind).toBe('scheduler');
    expect(describeBlame(b)).toContain('руками его не запустить');
  });

  it('свидетель протух — общий отказ, секрет снова под подозрением', () => {
    const b = blameSilentCrons({ agentId: 'safety-ingest', minutesAgo: 400 }, 300);
    expect(b.kind).toBe('platform');
    expect(describeBlame(b)).toContain('CRON_SECRET');
  });
});
