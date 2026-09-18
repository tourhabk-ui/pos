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
