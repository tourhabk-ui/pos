/**
 * Сторож правила «снимки мест живут в хранилище» (решение владельца 18.09).
 *
 * ── Откуда правило ────────────────────────────────────────────────────────
 *
 * Владелец спросил: «фото все на s3?». Ни одного. Перепись с прода в тот же
 * день: база 882,2 МБ, из них таблица снимков 441,8 — ровно половина, 659
 * строк байтами в PostgreSQL. Рядом оплаченное хранилище на 100 ГБ, уже
 * используемое для пакетов карты.
 *
 * Переезд при этом был НАПИСАН 08.09 и написан осторожно: залить, прочитать
 * обратно, сверить размер, и только потом обнулить байты. Но звать его было
 * нечем — ни расписания, ни маркера, и он числился ручным.
 *
 * Третий случай одной болезни за сутки: миграция без пути в CI, фильтр
 * фотографий со своим списком родов в тринадцати файлах, переезд без вызова.
 * Каждый раз механизм есть, а хода до прода у него нет, и молчание читается
 * как «всё в порядке».
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Не абзац, а связку: у правила есть производитель (уборщик по расписанию),
 * он зовёт ТОТ адрес, он не дерётся с ручным актуатором за ту же таблицу, и
 * переезд не объявлен ручным вторым ответом на тот же вопрос.
 *
 * Сторож намеренно НЕ проверяет, что в базе ноль байтов: это состояние
 * данных, оно меняется между прогонами и живёт на проде, а не в репозитории.
 * Его называет перепись `GET /api/cron/db-size-census`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SWEEPER = '.github/workflows/cron-images-to-s3.yml';
const ACTUATOR = '.github/workflows/images-repack.yml';

interface Wf {
  on?: { schedule?: Array<{ cron?: string }> };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, { 'timeout-minutes'?: number }>;
}
const wf = (p: string): Wf => {
  const doc = load(read(p)) as Record<string, unknown>;
  return { ...doc, on: (doc['on'] ?? doc[true as unknown as string]) as Wf['on'] } as Wf;
};

describe('у правила есть производитель', () => {
  const sweeper = wf(SWEEPER);
  const src = read(SWEEPER);

  it('уборщик ходит по расписанию, а не ждёт руки', () => {
    // Ровно того и не хватало переезду с 08.09 по 18.09.
    const cron = sweeper.on?.schedule?.[0]?.cron;
    expect(typeof cron).toBe('string');
    expect(cron).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it('зовёт именно переезд снимков', () => {
    expect(src).toContain('/api/cron/images-to-s3');
    // Тело собирается в bash, кавычки в нём экранированы — проверяем ту
    // форму, что реально лежит в файле, а не ту, что хочется прочесть.
    expect(src).toMatch(/\\"dry_run\\": false/);
  });

  it('причина у прогона названа и не пуста', () => {
    // Роут её требует; пустая строка провалила бы каждую партию молча.
    const m = src.match(/REASON='([^']+)'/);
    expect(m?.[1]?.length ?? 0).toBeGreaterThanOrEqual(10);
  });

  it('прогон останавливается, когда везти нечего', () => {
    // Без этого цикл крутил бы пустые партии до потолка и красил прогон
    // временем, а не делом.
    expect(src).toMatch(/\[ "\$DID" -gt 0 \] \|\| break/);
  });
});

describe('две руки не дерутся за одну таблицу', () => {
  it('уборщик и ручной актуатор в одной очереди, без отмены', () => {
    // Одна партия читает байты, которые другая уже обнулила, — это не
    // теоретическая гонка: обе стороны пишут в ai_route_images.
    const a = wf(SWEEPER).concurrency;
    const b = wf(ACTUATOR).concurrency;
    expect(a?.group).toBe(b?.group);
    expect(a?.['cancel-in-progress']).toBe(false);
    expect(b?.['cancel-in-progress']).toBe(false);
  });

  it('переезд не объявлен ещё и ручным', () => {
    // Два ответа на вопрос «кто это запускает» — это ни одного ответа.
    // Тот же довод держит cron-scheduler-declared; здесь он закреплён
    // поимённо, потому что именно эта запись прожила десять дней.
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).not.toMatch(/'images-to-s3':\s*\{/);
  });
});

describe('актуатор умеет ту же задачу вручную', () => {
  const src = read(ACTUATOR);

  it('у images-repack есть задача s3', () => {
    // Расписание закрывает поток, рука нужна для разовых партий и разбора.
    expect(src).toMatch(/'recompress', 'generated', 's3'/);
    expect(src).toContain('/api/cron/images-to-s3');
  });

  it('счётчик перевезённого читается из ответа', () => {
    // Без moved_count цикл увидел бы ноль сделанного и остановился после
    // первой же успешной партии.
    expect(src).toContain("a.get('moved_count'");
  });
});

describe('галерея мест тоже едет в хранилище (13.10)', () => {
  it('уборщик знает place_gallery_photos, а не только героя', () => {
    // До 13.10 шапки миграций обещали «байты увезёт уборщик», а уборщик галереи
    // не знал: правило «увозит всё» держалось только на герое (§4.1).
    const route = readFileSync(join(process.cwd(), 'app/api/cron/images-to-s3/route.ts'), 'utf-8');
    expect(route).toContain('FROM place_gallery_photos');
    expect(route).toContain('async function backfillUrls()');
  });
});

// Владелец 22.11, снимок с телефона: «фото не адаптированы». Копия 480 px под
// карточку (scope thumb, миграция 1138) делалась только рукой, одним прогоном
// 02.10; снимки позже остались без копии, и карточка тянула оригинал. Теперь
// копии делает тот же ночной прогон. Шаг судится исполнением: настоящий bash,
// подложенный curl отвечает заданной очередью ответов двери.
describe('ночной прогон делает копии под карточку', () => {
  const doc = load(read(SWEEPER)) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  const step = Object.values(doc.jobs).flatMap((j) => j.steps).find((s) => s.name === 'Копии снимков под карточку');

  const runStep = async (responses: Array<{ code: number; body: unknown }>) => {
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync: rd, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'thumb-step-'));
    responses.forEach((r, i) => {
      writeFileSync(join(dir, `resp${i + 1}.json`), JSON.stringify(r.body));
      writeFileSync(join(dir, `code${i + 1}`), String(r.code));
    });
    // curl: -o <файл> -d <тело>; тело — в журнал, ответ — следующий по очереди.
    writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash
out=''; body=''
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -d) body="$2"; shift 2;; *) shift;; esac; done
n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/n"
printf '%s\\n' "$body" >> "${dir}/bodies"
if [ -f "${dir}/resp$n.json" ]; then cp "${dir}/resp$n.json" "$out"; printf '%s' "$(cat "${dir}/code$n")"; else echo '{}' > "$out"; printf '500'; fi
`);
    chmodSync(join(dir, 'curl'), 0o755);
    const summary = join(dir, 'summary.md');
    const res = spawnSync('bash', ['-e', '-c', step!.run!], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CRON_SECRET: 'test-secret', BASE: 'https://example.test', GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    });
    const bodies = existsSync(join(dir, 'bodies')) ? rd(join(dir, 'bodies'), 'utf8').trim().split('\n') : [];
    return { status: res.status, out: `${res.stdout}${res.stderr}`, bodies, summary: existsSync(summary) ? rd(summary, 'utf8') : '' };
  };
  const ok = (made: number, skipped: number, failed: number, pending: number) =>
    ({ code: 200, body: { ok: true, scope: 'thumb', recompressed_count: made, skipped_count: skipped, failed_count: failed, pending_before: pending } });

  it('шаг есть и ходит после переезда', () => {
    const names = Object.values(doc.jobs).flatMap((j) => j.steps).map((s) => s.name);
    expect(step).toBeDefined();
    expect(names.indexOf('Копии снимков под карточку')).toBeGreaterThan(names.indexOf('Перевезти остаток снимков в хранилище'));
  });

  it('просит дверь копий боевой партией scope thumb с причиной', async () => {
    const r = await runStep([ok(10, 0, 0, 25), ok(10, 0, 0, 15), ok(4, 1, 0, 5), ok(0, 0, 0, 0)]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.bodies[0]) as Record<string, unknown>;
    expect(body).toMatchObject({ scope: 'thumb', dry_run: false });
    expect(String(body.reason).length).toBeGreaterThanOrEqual(10);
    expect(r.bodies).toHaveLength(4);
    expect(r.summary).toContain('сделано копий: **24**');
  });

  it('партия без прогресса — конец, а не круг пустых партий; отказы названы', async () => {
    const r = await runStep([ok(3, 0, 2, 5), ok(0, 0, 2, 2), ok(0, 0, 0, 0)]);
    expect(r.status).toBe(0);
    expect(r.bodies).toHaveLength(2);
    expect(r.out).toMatch(/::warning::копии под карточку: не сделано 4/);
  });

  it('дверь ответила не 200 — шаг красный', async () => {
    const r = await runStep([ok(2, 0, 0, 3), { code: 503, body: { ok: false } }]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::копии под карточку: дверь ответила HTTP 503 на партии 2/);
  });
});
