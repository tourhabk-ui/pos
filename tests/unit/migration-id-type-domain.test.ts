/**
 * Идентификатор сверяется в одном домене типов.
 *
 * Миграция 874 не применялась на проде шесть попыток подряд, и реестр отказов
 * назвал причину словами: `operator does not exist: text = uuid`.
 *
 * В этой схеме «одинаковый id» живёт в двух типах сразу — и расходятся даже
 * две колонки одной таблицы (типы измерены на проде, не взяты из объявлений):
 *
 *   kamchatka_routes.id       — uuid
 *   places.id                 — text
 *   route_waypoints.route_id  — uuid
 *   route_waypoints.place_id  — text
 *
 * 167 объявляла обе колонки route_waypoints как UUID, но создавала таблицу
 * через `CREATE TABLE IF NOT EXISTS` поверх уже существовавшей — объявление не
 * применилось, и угадать, какая колонка какого типа, по файлам миграций нельзя.
 *
 * Работает это только на удаче неявных приведений: INSERT приводит text→uuid
 * присваиванием, а сравнение `=` — нет, для него такого оператора просто не
 * существует. Поэтому миграция, которая пишет `rw.route_id = m.route_id::uuid`,
 * читается правильной и падает целиком.
 *
 * Лечится не угадыванием типа, а отказом от предположения: обе стороны
 * приводятся к тексту. `uuid::text` даёт канонический нижний регистр, `text` не
 * меняется, и сравнение перестаёт зависеть от того, что объявлено в миграции
 * десятилетней давности. Обратное приведение (к `uuid`) запрещено отдельно:
 * `places.id` — свободный текст, и первая же не-uuid запись уронит прогон на
 * самом приведении, ещё до всякого сравнения.
 *
 * Сторож смотрит только НОВЫЕ миграции (870+). Старые уже применились такими,
 * какие есть, и переписывать применённое нельзя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'migrations');
const FROM = 870;

/** Столбцы, чей тип на проде разошёлся с объявлением. */
const ID_COLUMNS = /\b\w+\.(route_id|place_id|id)\b/;

function newMigrations(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const n = Number(f.slice(0, 3));
      return Number.isFinite(n) && n >= FROM;
    });
}

/**
 * Псевдонимы списков VALUES: `) AS m(route_id, place_id)`.
 *
 * У литерала из VALUES своего типа нет — он принимает тип второй стороны
 * сравнения. Значит такая сторона никогда не бывает виновной, и требовать от
 * неё `::text` бессмысленно.
 */
function valuesAliases(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\)\s*AS\s+(\w+)\s*\(/gi)) out.add(m[1]);
  return out;
}

/** Строки кода без комментариев — сравнения ищем только в них. */
function codeLines(sql: string): string[] {
  return sql.split('\n').map((l) => {
    const at = l.indexOf('--');
    return at === -1 ? l : l.slice(0, at);
  });
}

/**
 * Вырезать присваивания `UPDATE … SET x = y`, оставив всё прочее на месте.
 *
 * Присваивание — НЕ сравнение, и это не послабление, а ровно то, что написано
 * в шапке этого файла: text→uuid Постгрес приводит присваиванием сам, а
 * оператора `=` для такой пары не существует вовсе. Требовать `::text` от
 * `SET user_id = u.id` значит требовать приведения там, где путаницы доменов
 * быть не может (14.09, миграция 970 — ложное срабатывание ровно на этой
 * строке).
 *
 * Дыры это не открывает: опасное присваивание `SET user_id =
 * (metadata->>'user_id')::uuid` ловит соседняя проверка «идентификаторы не
 * приводятся к uuid», и ловит по другой причине — не по домену сравнения, а по
 * тому, что приведение падает на первой же кривой записи.
 *
 * Разбор идёт по состоянию, а не построчно: `SET` открывает область
 * присваиваний, `FROM` / `WHERE` / `RETURNING` / `;` её закрывают, и область
 * переживает перенос строки — в UPDATE на четыре строки SET стоит на одной, а
 * WHERE на другой.
 */
function stripSetAssignments(lines: string[]): string[] {
  let inSet = false;
  return lines.map((line) => {
    let rest = line;
    let out = '';
    for (;;) {
      if (rest.length === 0) break;
      if (!inSet) {
        const open = /\bSET\b/i.exec(rest);
        if (!open) { out += rest; break; }
        out += rest.slice(0, open.index + open[0].length);
        rest = rest.slice(open.index + open[0].length);
        inSet = true;
      } else {
        const close = /\b(?:FROM|WHERE|RETURNING)\b|;/i.exec(rest);
        if (!close) break;           // весь остаток строки — присваивания
        rest = rest.slice(close.index);
        inSet = false;
      }
    }
    return out;
  });
}

/**
 * Одна сторона сравнения: колонка, при ней — необязательное извлечение из
 * JSONB (`metadata->>'user_id'`) и необязательное приведение.
 */
const SIDE = String.raw`[\w.]+(?:\s*->>\s*'[^']*')?(?:::\s*\w+)?`;
const COMPARISON = new RegExp(String.raw`(${SIDE})\s*=\s*(${SIDE})`);

/** Строки-сравнения, где тип идентификатора предполагается. */
export function assumedIdTypes(sql: string): string[] {
  const literals = valuesAliases(sql);
  const bad: string[] = [];
  const original = codeLines(sql);
  stripSetAssignments(original).forEach((code, i) => {
    const line = original[i]!;
    // Дешёвый отсев ДО тяжёлой регулярки сравнения, и он не меняет ни одного
    // вердикта: находка требует `ID_COLUMNS` хотя бы на одной из сторон, а
    // сторона — часть строки. Значит строка, где `ID_COLUMNS` не встречается
    // вовсе, находкой стать не может ни при каком разборе.
    //
    // Отсев нужен не для красоты. `SIDE` начинается с `[\w.]+`, и на длинном
    // прогоне словесных символов, за которым стоит `=`, движок перебирает
    // каждую позицию с возвратами — то есть ровно на base64 с его `=` в
    // хвосте. 19.09 этот сторож упал в CI по таймауту 5 с (локально зелёный):
    // 2,1 с из 2,2 съедали миграции с фотографиями владельца, и 678 мс из них
    // — один файл 958. Поднимать таймаут значило бы оставить бомбу с более
    // длинным запалом: следующая миграция со снимком вернула бы тот же отказ.
    if (!ID_COLUMNS.test(code)) return;
    const m = code.match(COMPARISON);
    if (!m) return;
    const [, left, right] = m;
    if (!ID_COLUMNS.test(left) && !ID_COLUMNS.test(right)) return;
    // Целочисленный литерал (`ot.id = 4`) выводит сравнение из-под саги
    // uuid↔text целиком, а не требует приведения ВТОРОЙ стороны тоже: сама
    // проблема, которую ловит этот гард, — Постгрес молча путает домены двух
    // КОЛОНОК (uuid и text не сравниваются оператором `=`, а несовпадение
    // всплывает только на исполнении). Integer-литерал вообще не участвует в
    // этой путанице: если колонка слева окажется text/uuid, а не числом,
    // Постгрес сам откажет на исполнении («operator does not exist») —
    // раньше, чем до этого места дойдёт кто-то из читателей. Требовать от
    // литерала «докажи, что ты текст» бессмысленно и ловит только шум
    // (24.08, миграция 914 — ложное срабатывание на `WHERE ot.id = 4`,
    // где operator_tours.id — bigint).
    const isIntLiteral = (side: string) => /^-?\d+$/.test(side.trim());
    if (isIntLiteral(left) || isIntLiteral(right)) return;
    // Текстом сторона бывает не только по явному `::text`. Оператор `->>` в
    // PostgreSQL ВСЕГДА возвращает text — по определению, а не по удаче
    // (`->` тем же местом отдаёт jsonb, и он тут не в счёт). Требовать от
    // `metadata->>'user_id'` доказать, что он текст, — требовать приведения
    // текста к тексту.
    const jsonText = (side: string) => /->>\s*'/.test(side);
    const typed = (side: string) =>
      /::\s*text\b/i.test(side) || jsonText(side) || literals.has(side.split('.')[0]);
    if (typed(left) && typed(right)) return;
    bad.push(`${i + 1}: ${line.trim()}`);
  });
  return bad;
}

describe('сторож ловит ровно тот отказ, что стоил шести попыток', () => {
  it('падавшая редакция 874 опознана', () => {
    const was = `UPDATE route_waypoints rw SET link_kind = 'waypoint'
  FROM (VALUES ('a','b')) AS m(route_id, place_id)
 WHERE rw.route_id = m.route_id::uuid;`;
    expect(assumedIdTypes(was).length).toBeGreaterThan(0);
  });

  it('починенная редакция чиста', () => {
    const now = `UPDATE route_waypoints rw SET link_kind = 'waypoint'
  FROM (VALUES ('a','b')) AS m(route_id, place_id)
 WHERE rw.route_id::text = m.route_id;`;
    expect(assumedIdTypes(now)).toEqual([]);
  });

  it('сверка колонок двух таблиц без приведения опознана', () => {
    expect(assumedIdTypes('WHERE p.id = rw.place_id').length).toBeGreaterThan(0);
    expect(assumedIdTypes('WHERE p.id::text = rw.place_id::text')).toEqual([]);
  });

  it('строковый литерал не считается сравнением типов', () => {
    expect(assumedIdTypes("WHERE rw.link_kind = 'unknown'")).toEqual([]);
  });

  it('целочисленный литерал (WHERE ot.id = 4) — не саге uuid↔text, не ловится', () => {
    // Замер 24.08: миграция 914 (`WHERE ot.id = 4 AND ...`) ложно опознавалась
    // как «сравниваем id без приведения» — у числа нет неоднозначного домена.
    expect(assumedIdTypes('WHERE ot.id = 4')).toEqual([]);
    expect(assumedIdTypes('WHERE ot.id = -1')).toEqual([]);
  });

  it('присваивание в SET — не сравнение', () => {
    // 14.09, миграция 970: `SET user_id = u.id` — присваивание uuid в uuid.
    expect(assumedIdTypes('UPDATE b SET user_id = u.id')).toEqual([]);
  });

  it('SET не прикрывает собой WHERE того же запроса', () => {
    // Область присваиваний обязана ЗАКРЫВАТЬСЯ: иначе одно послабление
    // выключило бы сторожа на всех UPDATE разом — а именно UPDATE и была
    // миграция 874, стоившая шести попыток.
    const sql = `UPDATE route_waypoints rw
   SET link_kind = 'waypoint'
  FROM places p
 WHERE rw.place_id = p.id;`;
    expect(assumedIdTypes(sql).length).toBeGreaterThan(0);
  });

  it('извлечение ->> считается текстом, а -> нет', () => {
    // `->>` возвращает text по определению оператора; `->` возвращает jsonb, и
    // сравнивать его с идентификатором — та же путаница доменов.
    expect(assumedIdTypes("WHERE u.id::text = b.metadata->>'user_id'")).toEqual([]);
    expect(assumedIdTypes("WHERE u.id::text = b.metadata->'user_id'").length).toBeGreaterThan(0);
  });

  it('дешёвый отсев не прячет находку на строке с посторонним длинным токеном', () => {
    // Отсев пропускает дальше любую строку, где встречается `таблица.id`-форма,
    // даже если рядом лежит длинный мусор: он отбрасывает только строки, где
    // такой формы нет вовсе и находка невозможна по построению.
    const blob = 'A'.repeat(4000) + '==';
    expect(assumedIdTypes(`WHERE p.id = rw.place_id AND data = '${blob}'`).length).toBeGreaterThan(0);
    // А строка без `таблица.id` находкой не была и до отсева.
    expect(assumedIdTypes(`INSERT INTO ai_route_images (place_id, image_data) VALUES ('x', '${blob}')`)).toEqual([]);
  });

  it('строковый литерал в кавычках регулярка сравнений не видит вовсе — как и раньше', () => {
    // `[\w.]+` не матчит кавычки: `ot.id = '4'` не попадает под регулярку
    // сравнения ни до этой правки, ни после — послабление для целых
    // литералов тут ни при чём, это independent свойство самого паттерна
    // (тот же факт, что и «строковый литерал не считается сравнением типов»
    // выше, только с цифрой внутри кавычек).
    expect(assumedIdTypes("WHERE ot.id = '4'")).toEqual([]);
  });
});

describe('новые миграции не предполагают тип идентификатора', () => {
  const files = newMigrations();
  // Каждый файл читается с диска ОДИН раз на весь блок, а не заново в каждой
  // проверке. 19.09 проверка сравнений упала в CI по таймауту 5 с при зелёном
  // прогоне локально: два блока перечитывали все новые миграции целиком, и на
  // загруженном раннере этого хватало. Поднимать таймаут было бы лечением
  // симптома — лишнее чтение не нужно ни одной из проверок.
  const sources: Array<{ file: string; text: string }> = files.map(f => ({
    file: f, text: readFileSync(join(DIR, f), 'utf-8'),
  }));

  it('новые миграции найдены', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('идентификаторы не приводятся к uuid', () => {
    const bad: string[] = [];
    for (const { file, text } of sources) {
      codeLines(text).forEach((line, i) => {
        if (/::\s*uuid\b/i.test(line) && /=/.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, 'приведение к uuid падает на первой же не-uuid записи places.id').toEqual([]);
  });

  it('в сравнении идентификаторов обе стороны — текст', () => {
    const bad: string[] = [];
    for (const { file, text } of sources) {
      for (const line of assumedIdTypes(text)) {
        bad.push(`${file}:${line}`);
      }
    }
    expect(bad, 'сверять id разных таблиц можно только приведя обе стороны к тексту').toEqual([]);
  });
});
