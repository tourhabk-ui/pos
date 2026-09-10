/**
 * Сторож §4.0: у прогона крона три исхода, и «не смог» не равен «хорошо».
 *
 * 23.08 один дефект нашёлся в трёх кронах сразу: recordCronRun(..., 'success')
 * стоял ДО всякой работы, а ветки 'failed' не было вовсе. Упавший прогон отдавал
 * 500 и при этом оставлял в журнале запись об успехе — liveness Watchdog'а
 * (lib/agents/cron-registry) видел здоровый крон там, где он не работал.
 * Это ровно то «молчаливое согласие», ради которого писано правило третьего
 * состояния: место, где нельзя сказать «не смог», отвечает «хорошо».
 *
 * Правило проверяемое: кто пишет 'success', обязан уметь написать 'failed'.
 * Ранние выходы («работы не было», «бюджет не задан») правилу не мешают —
 * у них есть свой честный исход, и ветка отказа в файле всё равно нужна.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CRON_DIR = join(process.cwd(), 'app/api/cron');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

// [^;] не пускает совпадение через границу инструкции: иначе 'failed' из
// соседнего SQL-литерала засчитался бы за ветку отказа.
const REPORTS_SUCCESS = /recordCronRun\([^;]*?'success'/s;
const REPORTS_FAILED  = /recordCronRun\([^;]*?'failed'/s;

describe('крон, пишущий heartbeat, обязан уметь сказать «не смог»', () => {
  const files = routeFiles(CRON_DIR).filter((f) =>
    readFileSync(f, 'utf8').includes('recordCronRun'),
  );

  it('крон-роуты с heartbeat вообще найдены', () => {
    // Ноль файлов при нулевом входе — отказ, а не успех: если сканер перестал
    // находить роуты, все проверки ниже станут зелёными и бессмысленными.
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    const rel = file.slice(file.indexOf('app/api/cron'));
    it(`${rel}: есть ветка 'failed'`, () => {
      const src = readFileSync(file, 'utf8');
      if (!REPORTS_SUCCESS.test(src)) return; // heartbeat только импортирован
      expect(REPORTS_FAILED.test(src)).toBe(true);
    });
  }
});

describe('abandoned-bookings: часы не переставляет тот, кого они считают', () => {
  const src = readFileSync(
    join(CRON_DIR, 'abandoned-bookings/route.ts'), 'utf8',
  );

  it('возраст брони считается от created_at', () => {
    expect(src).toContain("created_at < NOW() - INTERVAL '24 hours'");
  });

  it('updated_at не участвует в отборе', () => {
    // Триггер trigger_operator_bookings_timestamp (миграция 040) двигает
    // updated_at при любом UPDATE — включая нашу же отметку о напоминании.
    expect(/updated_at\s*[<>]\s*NOW\(\)/.test(src)).toBe(false);
  });

  it('отказ записи отметки не глушится пустым catch', () => {
    expect(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(src)).toBe(false);
  });
});

/**
 * safety-ingest пишет heartbeat не через recordCronRun, а своим INSERT — и
 * потому проверка выше его не видела. 09.09 (#1759) он двадцать часов писал
 * 'success' безусловно при отказе на каждом прогоне; сторожа серии читали
 * этот статус и молчали. Правило то же, адресат другой.
 */
describe('safety-ingest: heartbeat не пишет success безусловно (#1759)', () => {
  const SRC = readFileSync(join(CRON_DIR, 'safety-ingest/route.ts'), 'utf8');
  // Тело logHeartbeat целиком — от объявления до перехвата ошибки записи:
  // фиксированная длина среза красна на верной правке формы.
  const start = SRC.indexOf('function logHeartbeat(');
  const insert = SRC.slice(start, SRC.indexOf('.catch(', start));

  it("статус — параметр запроса, а не литерал 'success'", () => {
    expect(insert).not.toMatch(/VALUES \('safety-ingest', 'success'/);
    expect(insert).toMatch(/VALUES \('safety-ingest', \$5/);
  });

  it('статус считается общей функцией по своим источникам в обоих запусках', () => {
    // GET и POST владеют разными источниками: считать GET по t.me значило бы
    // вечный partial (гео-блок с хостинга) и вечную ложную тревогу.
    expect((SRC.match(/ingestRunStatus\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(SRC).toMatch(/getSources: RunSource\[\]/);
    expect(SRC).toMatch(/postSources: RunSource\[\]/);
    const getBlock = SRC.slice(SRC.indexOf('const getSources'), SRC.indexOf("'heartbeat_get'"));
    expect(getBlock).not.toMatch(/kbgsras|eqkam/);
  });

  it('неуспех оставляет в metadata класс и адрес починки — их читает алерт', () => {
    expect(insert).toMatch(/skip_reason: 'fetch_failed'/);
    expect(insert).toMatch(/empty_reasons: detail/);
  });

  it('у класса fetch_failed есть подпись словами', () => {
    const labels = readFileSync(join(process.cwd(), 'lib/agents/scout-skip-reasons.ts'), 'utf8');
    expect(labels).toMatch(/fetch_failed: '/);
  });
});
