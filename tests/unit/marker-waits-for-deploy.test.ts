/**
 * Сторож: прогон по маркеру ждёт СВОЮ сборку, если зовёт прод.
 *
 * ── Что случилось (07.09, трижды за сутки) ─────────────────────────────────
 *
 * Маркер — файл в репозитории, и правка его едет в main ВМЕСТЕ с кодом. Прогон
 * стартует через секунды после мержа, а Timeweb собирает образ 5–20 минут.
 * Значит прогон по маркеру бьёт по СТАРОМУ проду, если не подождать.
 *
 * Цена трёх повторений за один день:
 *
 *  1. посты Кузьмича: ответ пришёл без поля `photo`, которое добавлено тем же
 *     коммитом; два поста ушли в канал, а вопрос «есть ли картинка» остался
 *     без ответа;
 *  2. те же посты во второй раз — по той же причине;
 *  3. Editor на раннере: HTTP 404 на `/api/cron/editor-job` — эндпоинта на
 *     проде ещё не существовало.
 *
 * Каждый раз красный был ЧЕСТНЫМ (шаги называли причину словами), и каждый раз
 * работа не была сделана. Честный отказ не заменяет сделанной работы.
 *
 * ── Что держит сторож ──────────────────────────────────────────────────────
 *
 * Список ниже — замер 07.09: workflow, которые запускаются маркером, зовут
 * прод и НЕ ждут сборку. Он может только СОКРАЩАТЬСЯ. Новый workflow с
 * маркером, который ходит на vedarai.ru, обязан подождать — иначе первый же
 * его прогон проверит вчерашний прод.
 *
 * Почему не потребовать ожидания у всех сразу: большинству из списка новый код
 * не нужен — они зовут давно живущие эндпоинты, и лишние минуты ожидания на
 * каждой диагностике стоят дороже пользы. Сокращать список по одному, когда
 * workflow меняется, честнее, чем разом переписать сорок файлов ночью.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const WF_DIR = join(process.cwd(), '.github/workflows');
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f: string) => readFileSync(join(WF_DIR, f), 'utf8');

/** Запускается маркером И зовёт прод. */
function markerCallsProd(src: string): boolean {
  return /triggers\/[\w-]+\.json/.test(src) && /vedarai\.ru/.test(src);
}
const waits = (src: string) => /run: bash scripts\/wait-for-deploy\.sh/.test(src);

/**
 * Замер 07.09. Список может только СОКРАЩАТЬСЯ: строка удаляется, когда
 * workflow начинает ждать. Это НЕ общая амнистия — новый файл сюда не
 * добавляется, он обязан ждать сразу.
 */
const NO_WAIT_MEASURED_07_09 = [
  'channel-post-tour.yml',
  'channel-post.yml',
  'cron-enrich-routes.yml',
  'cron-intelligence.yml',
  'cron-osm-traces.yml',
  'cron-safety-check.yml',
  'cron-ssr-sentinel.yml',
  'data-bucket-cors.yml',
  'data-inventory.yml',
  'data-pmtiles.yml',
  'data-repair.yml',
  'diag-prod.yml',
  'e2e-smoke.yml',
  'enrich-passports-prod.yml',
  'eval-kuzmich.yml',
  'evo-apply.yml',
  'evo-issues-report.yml',
  'evo-judge.yml',
  'evo-review.yml',
  'import-dem-elevations.yml',
  'import-osm-geometry-prod.yml',
  'map-places-build.yml',
  'nightly-consistency.yml',
  'ocr-opendataloader.yml',
  'ocr-passports-prod.yml',
  'perimeter-smoke.yml',
  'place-coords.yml',
  'places-audit.yml',
  'places-dedup.yml',
  'places-geocode.yml',
  'places-unmerge.yml',
  'probe-url.yml',
  'redteam-kuzmich.yml',
  'road-graph-census.yml',
  'route-data-audit.yml',
  'route-endpoints-batch.yml',
  'route-links-repair.yml',
  'route-popularity.yml',
  'routes-audit.yml',
  'safety-ledger-check.yml',
  'schema-registry-census.yml',
];

describe('маркер не бьёт по старому проду', () => {
  it('новый workflow с маркером, зовущий прод, ждёт свою сборку', () => {
    const offenders = files
      .filter((f) => markerCallsProd(read(f)) && !waits(read(f)))
      .filter((f) => !NO_WAIT_MEASURED_07_09.includes(f));
    expect(
      offenders,
      `запускается маркером и зовёт прод, но не ждёт сборку: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('список замера может только сокращаться: каждый файл из него существует и всё ещё не ждёт', () => {
    const stale = NO_WAIT_MEASURED_07_09.filter((f) => !files.includes(f) || waits(read(f)));
    expect(
      stale,
      `строку из списка пора удалить (файла нет или он уже ждёт): ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('у кого есть расписание — ждут ТОЛЬКО по маркеру', () => {
    // По расписанию head_commit пуст, и шаг честно ждал бы «свою сборку»,
    // которой никто не просил, — двадцать пять минут впустую каждую ночь.
    // У workflow БЕЗ расписания такой оговорки не нужно: они запускаются
    // только маркером или кнопкой, и ждать своей сборки правильно всегда.
    for (const f of files.filter((x) => waits(read(x)))) {
      const src = read(f);
      if (!/^\s*schedule:/m.test(src)) continue;
      // Шаг = от заголовка «- name:» до самого вызова. Окно фиксированной
      // длины не годится: у некоторых шагов комментарий длиннее окна.
      // Ищем ВЫЗОВ, а не упоминание: в комментарии к checkout имя скрипта
      // встречается раньше самого шага, и поиск по имени брал не тот кусок.
      const at = src.indexOf('run: bash scripts/wait-for-deploy.sh');
      const step = src.slice(src.lastIndexOf('- name:', at), at);
      expect(step, f).toMatch(/if:\s*github\.event_name == 'push'/);
    }
  });
});
