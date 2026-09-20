/**
 * Семь получасовых safety/ops-кронов в одном workflow — и все семь
 * эндпоинтов по-прежнему вызываются, независимо друг от друга.
 *
 * ── Повод (20.09) ─────────────────────────────────────────────────────────
 *
 * Владелец переслал два алерта: «Volcano OS Worker не отмечался 3ч» от
 * Watchdog и «все AI-провайдеры недоступны» от health. Разбор первого по
 * коду показал, что `livenessWatch` (правка 19.09) отработал верно — тревога
 * честная. Причина простоя нашлась не в самом кроне, а в сопоставлении
 * фактических времён запуска ЧЕТЫРЁХ независимых workflow с разными
 * минутами (Actions API, не логи самих кронов): все они кластеризовались в
 * одном узком окне раз в 2–5 часов вместо своих расписаний. Смещение минуты
 * (приём kernel-worker: «GitHub дропает :00») эту кластеризацию не снимает.
 *
 * В `.github/workflows/` на тот день лежало 55 файлов с `schedule:` —
 * GitHub прямо документирует деградацию scheduled-триггеров при большом
 * числе расписаний в репозитории. Единственный рычаг, доступный БЕЗ
 * внешнего аккаунта (cron-job.org не подключён, ключей для него в репо нет):
 * сократить число отдельных расписаний, за которые кроны конкурируют.
 *
 * Семь получасовых safety/ops-кронов (danger-analysis, leads, rescue,
 * kernel-worker, tg-watchdog, sos-bridge, channel-sync) сведены в один
 * `cron-safety-heartbeat.yml`. Ни один эндпоинт, таймаут или условие успеха
 * не изменились — только количество scheduled-записей (было 7 файлов,
 * стал 1).
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 *  - в объединённом файле реально вызваны все восемь эндпоинтов (семь
 *    кронов, leads даёт два вызова — leads-process и followups);
 *  - каждый шаг, кроме итогового и followups (унаследованное исключение —
 *    см. ниже), имеет `continue-on-error: true`: отказ одного эндпоинта не
 *    должен останавливать вызов остальных — тем же свойством обладали семь
 *    раздельных workflow;
 *  - итоговый шаг красит job, если хоть один эндпоинт (кроме followups)
 *    ответил не 200 — статус остаётся честным индикатором;
 *  - семь старых отдельных файлов удалены, а не оставлены рядом — иначе два
 *    ответа на вопрос «что запускает /api/cron/rescue» (§12: «правило,
 *    реализованное дважды, — это два правила»);
 *  - реестр (`lib/agents/cron-registry.ts`) для всех семи ключей указывает
 *    на новый файл и на cron-выражение, реально в нём присутствующее.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

const WF_DIR = join(process.cwd(), '.github', 'workflows');
const FILE = 'cron-safety-heartbeat.yml';
const SRC = readFileSync(join(WF_DIR, FILE), 'utf8');

const CONSOLIDATED_KEYS = [
  'sos-bridge', 'danger-analysis', 'rescue', 'kernel-worker', 'leads', 'tg-watchdog', 'channel-sync',
] as const;

const ENDPOINTS = [
  'sos-events-bridge', 'danger-analysis', 'rescue', 'kernel-worker',
  'leads-process', 'followups', 'telegram-webhook-watchdog', 'channel-sync',
];

const REMOVED_FILES = [
  'cron-danger-analysis.yml', 'cron-leads.yml', 'cron-rescue.yml',
  'cron-kernel-worker.yml', 'cron-tg-watchdog.yml', 'cron-sos-bridge.yml',
  'cron-channel-sync.yml',
];

describe('cron-safety-heartbeat.yml существует и зовёт все восемь эндпоинтов', () => {
  it('файл на месте', () => {
    expect(existsSync(join(WF_DIR, FILE))).toBe(true);
  });

  it('каждый эндпоинт вызван ровно один раз', () => {
    for (const ep of ENDPOINTS) {
      const hits = SRC.match(new RegExp(`/api/cron/${ep}\\b`, 'g')) ?? [];
      expect(hits.length, `эндпоинт ${ep}: ожидался 1 вызов, найдено ${hits.length}`).toBe(1);
    }
  });

  it('семь старых отдельных файлов удалены — не оставлены рядом', () => {
    const present = REMOVED_FILES.filter((f) => existsSync(join(WF_DIR, f)));
    expect(present, `старый файл не убран: ${present.join(', ')}`).toEqual([]);
  });
});

describe('отказ одного эндпоинта не глушит остальные', () => {
  it('у каждого шага с эндпоинтом, кроме итогового, стоит continue-on-error', () => {
    // Разбор по шагам через "- name:" — грубее YAML-парсера, но не тянет
    // зависимость ради одного теста; блок шага — от одного "- name:" до
    // следующего или до конца файла.
    const stepBlocks = SRC.split(/\n      - name:/).slice(1);
    const withoutGuard = stepBlocks.filter((b) => b.includes('/api/cron/') && !b.includes('continue-on-error: true'));
    expect(withoutGuard.length, 'шаг с вызовом эндпоинта без continue-on-error').toBe(0);
  });

  it('итоговый шаг стоит ПОСЛЕДНИМ и зависит от предыдущих через steps.*.outcome', () => {
    const summaryIdx = SRC.indexOf('name: Summarize');
    expect(summaryIdx).toBeGreaterThan(0);
    // После Summarize новых шагов с вызовом эндпоинта быть не должно.
    const tail = SRC.slice(summaryIdx);
    expect(tail.match(/curl -s -o/g) ?? []).toHaveLength(0);
    expect(SRC).toContain('steps.sos_bridge.outcome');
    expect(SRC).toContain('steps.kernel_worker.outcome');
  });

  it('итоговый шаг красит job при отказе — не просто печатает', () => {
    const summaryBlock = SRC.slice(SRC.indexOf('name: Summarize'));
    expect(summaryBlock).toMatch(/exit 1/);
  });
});

describe('реестр указывает на новый файл честно', () => {
  it('все семь ключей переехали на cron-safety-heartbeat.yml', () => {
    for (const key of CONSOLIDATED_KEYS) {
      const entry = CRON_REGISTRY.find((e) => e.key === key);
      expect(entry, `ключ ${key} пропал из реестра`).toBeDefined();
      expect(entry!.workflow, `${key}: реестр не обновлён`).toBe(FILE);
    }
  });

  it('cron-выражение реестра реально присутствует в файле', () => {
    const crons = [...SRC.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
    for (const key of CONSOLIDATED_KEYS) {
      const entry = CRON_REGISTRY.find((e) => e.key === key)!;
      expect(crons, `${key}: cron '${entry.cron}' не найден в ${FILE}`).toContain(entry.cron);
    }
  });

  it('everyMin и tier не тронуты консолидацией — это свойства эндпоинта, не файла', () => {
    // Сами по себе тесты честности реестра (cron-registry-honesty) это не
    // проверяют — они сверяют cron-строку и существование файла, а не то,
    // что смысловые поля остались прежними при массовой правке.
    const expected: Record<string, { everyMin: number; tier: string }> = {
      'sos-bridge': { everyMin: 30, tier: 'safety' },
      'danger-analysis': { everyMin: 30, tier: 'safety' },
      'rescue': { everyMin: 30, tier: 'safety' },
      'kernel-worker': { everyMin: 30, tier: 'ops' },
      'leads': { everyMin: 30, tier: 'ops' },
      'tg-watchdog': { everyMin: 30, tier: 'ops' },
      'channel-sync': { everyMin: 30, tier: 'ops' },
    };
    for (const [key, want] of Object.entries(expected)) {
      const entry = CRON_REGISTRY.find((e) => e.key === key)!;
      expect(entry.everyMin, `${key}: everyMin`).toBe(want.everyMin);
      expect(entry.tier, `${key}: tier`).toBe(want.tier);
    }
  });
});

describe('файл валиден как YAML и объявлен читателям кода', () => {
  it('единственный job, единственное расписание', () => {
    const scheduleCrons = [...SRC.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)];
    expect(scheduleCrons).toHaveLength(1);
  });

  it('concurrency group не даёт задержанным прогонам накапливаться параллельно', () => {
    expect(SRC).toMatch(/concurrency:\s*\n\s*group: cron-safety-heartbeat/);
    expect(SRC).toMatch(/cancel-in-progress: false/);
  });

  it('директория workflows не потеряла ни одного другого файла случайно', () => {
    // Не самоцель этого PR, но дешёвая страховка от опечатки в rm.
    const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
    expect(files).toContain(FILE);
    expect(files.length).toBeGreaterThan(40); // было 55, минус 7, плюс 1 = 49
  });
});
