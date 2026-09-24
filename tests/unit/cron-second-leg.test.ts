// @vitest-environment node
/**
 * У частого крона есть вторая нога, и у второй ноги есть замок.
 *
 * ── Повод (21.09) ─────────────────────────────────────────────────────────
 *
 * Владелец спросил, почему трое суток нет ни сейсмики, ни предупреждений по
 * вулканам. Замер по Actions API за 5,3 суток:
 *
 *   cron-safety-ingest      40 прогонов вместо 1524 (медиана 188 мин при 5)
 *   cron-safety-heartbeat    6 прогонов вместо 30
 *   красных прогонов         0
 *
 * Планировщик GitHub не отказывает — он не запускает, поэтому не краснеет
 * ничего. Сведение семи получасовых файлов в один (20.09) голодания не сняло:
 * рычаг не в числе расписаний, а в том, что запуск живёт у GitHub.
 *
 * Работающий ответ существовал с 29.08 — супервизор контейнера в `start.js`.
 * Он и объясняет, почему тревоги приходили ИЗБИРАТЕЛЬНО: из семи сведённых
 * кронов прод-дублёр был у трёх, а звенели как раз те четыре, у которых его
 * не было («Volcano OS Worker не отмечался 3ч», health молчал 3–5 ч).
 *
 * ── Ложная тревога, снятая тем же замером ────────────────────────────────
 *
 * Измерив `cron-watchdog.yml` (30 прогонов вместо 203), я готов был доложить
 * владельцу, что SOS-таймаут с порогом 15 минут опаздывает в шесть раз. Это
 * неправда: `/api/cron/watchdog` стоит в `SAFETY_JOBS` с 29.08. Мерилась одна
 * нога из двух. Отсюда первое требование ниже — список ног обязан быть
 * прочитан из кода, а не из памяти о нём.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Не «в start.js есть список», а связку:
 *
 *   1. список читается и не пуст (иначе всё ниже зеленеет на пустоте);
 *   2. у КАЖДОГО крона реестра с периодом ≤ часа есть вторая нога — либо он
 *      в списке, либо записан в KNOWN_NO_SECOND_LEG с причиной;
 *   3. реестр непроизводимого самоустаревающий: появилась нога — запись
 *      обязана уйти (§10.09), и запись на несуществующий ключ краснеет;
 *   4. каждый путь второй ноги БЕРЁТ АРЕНДУ ОКНА. Это не формальность:
 *      без неё health слал бы один алерт дважды (у tgAlert дедупа нет), а
 *      leads-process дал бы гонку двух прогонов за одним лидом — два вызова
 *      LLM и два предложения на одну заявку. Запас без замка не запас;
 *   5. период второй ноги совпадает с реестром, а таймаут — с тем, что даёт
 *      работе workflow. Разойдись они, и один и тот же крон успевал бы у
 *      GitHub и не успевал здесь.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_REGISTRY, type CronEntry } from '@/lib/agents/cron-registry';

const ROOT = process.cwd();
const START = readFileSync(join(ROOT, 'start.js'), 'utf8');

/** Период, ниже которого голодание планировщика реально стоит денег или безопасности. */
const FREQUENT_MAX_MIN = 60;

/**
 * Кроны ≤ часа, у которых второй ноги НЕТ, и почему. Список самоустаревающий:
 * requirement (3) ниже краснеет, как только нога появилась, а запись осталась.
 * Реестр в markdown такого не умеет — он сам стал бы объявлением без
 * источника (§10.09).
 */
const KNOWN_NO_SECOND_LEG: Record<string, string> = {
  'volcano-merge-gate':
    'гейт пул-реквестов: живёт на стороне GitHub по своей природе, прод его заменить не может. ' +
    'Его простой (алерт 21.09, 5 ч) этим рычагом не лечится вовсе',
  'llm-budget':
    'в партию 21.09 не входил — владелец согласовал четыре получасовых и health. ' +
    'Решение о расширении принимает он, а не этот список',
  payments:
    'в партию 21.09 не входил — владелец согласовал четыре получасовых и health. ' +
    'Трогает деньги (§7), поэтому вторая нога заводится отдельным решением, а не заодно',
};

interface Leg {
  path: string;
  everyMin: number;
  timeoutMs: number;
}

/** Ноги читаются из кода, а не перечисляются здесь: список в тесте разошёлся бы с start.js. */
function parseLegs(src: string): Leg[] {
  const at = src.indexOf('const SAFETY_JOBS = [');
  if (at < 0) return [];
  const block = src.slice(at, src.indexOf('];', at));
  const out: Leg[] = [];
  const re = /path:\s*'([^']+)'[^}]*?everyMin:\s*(\d+)[^}]*?timeoutMs:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({ path: m[1], everyMin: Number(m[2]), timeoutMs: Number(m[3]) });
  }
  return out;
}

const LEGS = parseLegs(START);
const LEG_BY_ENDPOINT = new Map(LEGS.map((l) => [l.path.replace('/api/cron/', ''), l]));

/**
 * Эндпоинт записи реестра. Своё поле — когда workflow общий на несколько
 * записей; иначе выводится из самого workflow, как это делает
 * cron-registry-honesty.test.ts. Гадать по ключу нельзя: `leads` зовёт
 * `/api/cron/leads-process`, а `tg-watchdog` — `/api/cron/telegram-webhook-watchdog`.
 */
function endpointOf(entry: CronEntry): string | null {
  if (entry.endpoint) return entry.endpoint;
  const wf = join(ROOT, '.github/workflows', entry.workflow);
  if (!existsSync(wf)) return null;
  const hits = [...readFileSync(wf, 'utf8').matchAll(/\/api\/cron\/([a-z0-9-]+)/g)].map((m) => m[1]);
  return hits.length === 1 ? hits[0] : null;
}

const FREQUENT = CRON_REGISTRY.filter((e) => e.everyMin <= FREQUENT_MAX_MIN);

describe('список вторых ног читается из кода', () => {
  it('SAFETY_JOBS разобран и не пуст', () => {
    // Ноль ног при нулевом разборе — отказ, а не успех: сломайся regexp, и
    // все проверки ниже стали бы зелёными и бессмысленными (§4.0).
    expect(LEGS.length, 'SAFETY_JOBS в start.js не разобран').toBeGreaterThanOrEqual(11);
  });

  it('частые кроны в реестре вообще найдены', () => {
    expect(FREQUENT.length).toBeGreaterThanOrEqual(10);
  });
});

describe('у каждого частого крона есть вторая нога либо названная причина', () => {
  for (const entry of FREQUENT) {
    it(`${entry.key} (каждые ${entry.everyMin} мин)`, () => {
      const ep = endpointOf(entry);
      const hasLeg = ep !== null && LEG_BY_ENDPOINT.has(ep);
      const excuse = KNOWN_NO_SECOND_LEG[entry.key];

      if (hasLeg) {
        // Самоустаревание: нога появилась — запись об её отсутствии обязана уйти.
        expect(
          excuse,
          `${entry.key} стоит в SAFETY_JOBS, но числится в KNOWN_NO_SECOND_LEG — запись устарела и её надо убрать`,
        ).toBeUndefined();
        return;
      }

      expect(
        excuse,
        `${entry.key} идёт каждые ${entry.everyMin} мин ТОЛЬКО расписанием GitHub. ` +
          'Планировщик доставляет от него малую долю (замер 21.09), и молчание при этом не краснеет. ' +
          'Либо заведи вторую ногу в SAFETY_JOBS (start.js) с арендой окна в роуте, ' +
          'либо внеси ключ в KNOWN_NO_SECOND_LEG с причиной.',
      ).toBeTruthy();
      expect(String(excuse).length, 'причина не может быть отпиской').toBeGreaterThan(30);
    });
  }

  it('в KNOWN_NO_SECOND_LEG нет ключей, которых нет в реестре', () => {
    const keys = new Set(CRON_REGISTRY.map((e) => e.key));
    for (const k of Object.keys(KNOWN_NO_SECOND_LEG)) {
      expect(keys.has(k), `запись про ${k} пережила сам крон — её надо убрать`).toBe(true);
    }
  });
});

/**
 * Единственное исключение из аренды — и оно держится уликой, а не словом.
 *
 * `safety-ingest` идёт тремя планировщиками с 29.08 и аренды не берёт, но
 * повторный прогон у него безвреден ДОКАЗАННО: события гасятся контент-дедупом
 * и `ON CONFLICT (external_id) DO NOTHING` в `seismic-parser`, и это проверено
 * на настоящем PostgreSQL (`tests/integration/alert-dedup.pg.test.ts`).
 *
 * Поэтому проверка ниже не верит записи на слово: она требует, чтобы обе улики
 * были на месте. Исчезнет дедуп или его тест — исключение перестанет
 * действовать, и роут попадёт под общее правило. Список из одних имён был бы
 * дырой в стороже, а не исключением.
 */
const LEASE_EXEMPT: Record<string, { evidenceFile: string; evidenceNeedle: string; why: string }> = {
  'safety-ingest': {
    evidenceFile: 'lib/services/safety/seismic-parser.ts',
    evidenceNeedle: 'ON CONFLICT (external_id) DO NOTHING',
    why: 'повторный прогон не вставляет ничего дважды: контент-дедуп + ON CONFLICT, проверено на настоящем PostgreSQL',
  },
};

describe('вторая нога берёт аренду окна', () => {
  for (const leg of LEGS) {
    const ep = leg.path.replace('/api/cron/', '');
    it(`${ep}: claimCronWindow в роуте`, () => {
      const file = join(ROOT, 'app/api/cron', ep, 'route.ts');
      expect(existsSync(file), `роут ${leg.path} не найден — вторая нога звонила бы в никуда`).toBe(true);
      const src = readFileSync(file, 'utf8');

      const exempt = LEASE_EXEMPT[ep];
      if (exempt && !src.includes('claimCronWindow(')) {
        // Улика обязана быть на месте — иначе исключение самоотменяется.
        const evidence = readFileSync(join(ROOT, exempt.evidenceFile), 'utf8');
        expect(
          evidence.includes(exempt.evidenceNeedle),
          `${ep} освобождён от аренды тем, что ${exempt.why}, но улики (${exempt.evidenceNeedle} ` +
            `в ${exempt.evidenceFile}) больше нет — освобождение недействительно`,
        ).toBe(true);
        expect(
          existsSync(join(ROOT, 'tests/integration/alert-dedup.pg.test.ts')),
          'тест дедупа на настоящем PostgreSQL исчез — освобождение держалось на нём',
        ).toBe(true);
        return;
      }

      expect(
        src,
        `${ep} вызывается двумя планировщиками без аренды окна: два прогона в одном окне ` +
          'сделают работу дважды (двойной алерт, двойной вызов LLM, двойная запись)',
      ).toContain('claimCronWindow(');
    });
  }

  it('в LEASE_EXEMPT нет записей про роуты, которые аренду уже берут', () => {
    for (const ep of Object.keys(LEASE_EXEMPT)) {
      const file = join(ROOT, 'app/api/cron', ep, 'route.ts');
      if (!existsSync(file)) continue;
      expect(
        readFileSync(file, 'utf8').includes('claimCronWindow('),
        `${ep} берёт аренду — запись в LEASE_EXEMPT устарела и её надо убрать`,
      ).toBe(false);
    }
  });
});

describe('нога не расходится с тем, что обещано в другом месте', () => {
  for (const entry of FREQUENT) {
    const ep = endpointOf(entry);
    const leg = ep ? LEG_BY_ENDPOINT.get(ep) : undefined;
    if (!leg) continue;

    it(`${entry.key}: период совпадает с реестром`, () => {
      expect(leg.everyMin).toBe(entry.everyMin);
    });

    it(`${entry.key}: вторая нога ждёт не меньше, чем workflow`, () => {
      const wf = join(ROOT, '.github/workflows', entry.workflow);
      if (!existsSync(wf)) return;
      // Шаг workflow, в котором зовётся ИМЕННО этот эндпоинт: в общем файле
      // (cron-safety-heartbeat.yml) их восемь, и чужой --max-time не при чём.
      const step = readFileSync(wf, 'utf8')
        .split(/^\s*- name:/m)
        .find((s) => s.includes(`/api/cron/${ep}`));
      const m = step?.match(/--max-time\s+(\d+)/);
      if (!m) return; // таймаута в шаге нет — сверять не с чем, и выдумывать нельзя

      // Правило направленное, и направление не косметика. Дать БОЛЬШЕ времени
      // безвредно: работу всё равно ограничивает `maxDuration` самого роута.
      // Дать МЕНЬШЕ — значит перестать ждать раньше, чем крон успевает, и
      // получить «не ответил» там, где у GitHub тот же крон отвечает. Тогда
      // один и тот же код получает разные приговоры от двух планировщиков, и
      // разбирать придётся уже разницу между ними, а не сам крон.
      expect(
        leg.timeoutMs,
        `${ep}: workflow даёт ${m[1]} с, вторая нога — только ${leg.timeoutMs / 1000} с. ` +
          'Супервизор перестанет ждать раньше, чем крон успеет, и запишет отказ там, где его нет',
      ).toBeGreaterThanOrEqual(Number(m[1]) * 1000);
    });
  }
});
