/**
 * Контент-дедуп external_alerts — полевой дефект 01.08.
 *
 * Скриншот владельца с прода: «Сохраняется риск схода оползней и обвалов с
 * вулкана Мутновского» висел на /safety ТРИЖДЫ. Механика: дедуп вставки шёл
 * только по external_id (id поста), а суточная сводка ГУ МЧС публикуется
 * каждый день новым постом с тем же текстом пункта — каждый день новая строка
 * при живой старой. Дубли не только шумели на /safety: счётчик пилюли главной
 * считал их за отдельные угрозы.
 *
 * Починка в двух слоях, сторож держит оба:
 *   1) saveEvent: идентичный активный (type, title, description) →
 *      продлить expires_at (подтверждение угрозы), строку не плодить;
 *   2) миграция 792: существующие дубли схлопнуты до свежайшего.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PARSER = readFileSync(join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8');
const MIG_PATH = join(process.cwd(), 'migrations/792_dedup_external_alerts.sql');

describe('saveEvent не плодит строки с одинаковым содержимым', () => {
  // Тело saveEvent без комментариев — проверяем код, а не намерения в прозе.
  const body = PARSER.slice(PARSER.indexOf('export async function saveEvent'))
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('перед INSERT стоит проверка идентичного активного алерта', () => {
    expect(body, 'контент-дедуп исчез — суточные сводки МЧС снова размножатся')
      .toMatch(/UPDATE external_alerts[\s\S]*?alert_type = \$1[\s\S]*?lower\(trim\(title\)\)[\s\S]*?lower\(trim\(COALESCE\(description, ''\)\)\)[\s\S]*?expires_at > NOW\(\)/);
  });

  it('сравнение нормализованное — регистр и пробелы не заводят дубль (06.09)', () => {
    // Одно и то же ограничение с разных источников (kamgov, Минтур, ВК МЧС)
    // форматируется чуть по-разному — раньше это давало 5-6 отдельных строк
    // и 5-6 push об одном и том же. lower+trim+схлопнутые пробелы это ловит.
    expect(body).toMatch(/lower\(trim\(title\)\)/);
    expect(body).toMatch(/lower\(trim\(\$2\)\)/);
  });

  it('повтор текста ПРОДЛЕВАЕТ срок оригинала, а не теряется', () => {
    // «Сохраняется риск» назавтра — подтверждение угрозы. Молча пропустить
    // повтор = дать оригиналу истечь, пока угроза реально действует.
    expect(body).toMatch(/GREATEST\(expires_at,\s*\$4\)/);
  });

  it('дедуп срабатывает ДО вставки и завершает сохранение как skipped', () => {
    const dedupAt = body.indexOf('GREATEST(expires_at');
    const insertAt = body.indexOf('INSERT INTO external_alerts');
    expect(dedupAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(dedupAt);
    // Ветка дедупа (925: между условием и return теперь стоит запись в
    // Safety Decision Ledger — appendSafetyEvent) обязана заканчиваться
    // тем же исходом, return 'skipped', не только когда-то раньше в коде.
    expect(body).toMatch(/\(dup\.rowCount \?\? 0\) > 0\)\s*\{[\s\S]{0,700}?return 'skipped';/);
  });
});

describe('миграция 792 схлопывает уже накопленные дубли', () => {
  it('файл существует и удаляет строки старше свежайшей в группе', () => {
    expect(existsSync(MIG_PATH), 'миграции 792 нет — дубли в проде останутся навсегда').toBe(true);
    const sql = readFileSync(MIG_PATH, 'utf-8');
    expect(sql).toMatch(/DELETE FROM external_alerts[\s\S]*?newer\.created_at > ea\.created_at/);
    // Срок действия группы достаётся выжившей строке — до удаления.
    expect(sql.indexOf('UPDATE external_alerts')).toBeLessThan(sql.indexOf('DELETE FROM external_alerts'));
    expect(sql).toMatch(/GREATEST|MAX\(expires_at\)/);
  });
});

/**
 * Второй заход того же дефекта — 10.08, через другую дверь.
 *
 * Дедуп вставки (выше) ловит повтор при ЖИВОМ оригинале. А роут вулканов
 * намеренно отдаёт неделю истории, и в это окно попадают строки, чей срок уже
 * вышел: дедуп до них не дотягивается по построению. Проба прода вернула
 * «Сохраняется риск схода оползней и обвалов с вулкана Мутновского» СЕМЬ раз —
 * ровно тот экран, что владелец снимал 01.08, когда он висел трижды.
 *
 * Отсюда два обязательства, и оба обязаны жить в РОУТЕ, а не в клиенте:
 * клиентский дедуп работает после отсечки LIMIT и потому не полон — а тот,
 * что стоял в /hub/safety, вдобавок включал created_at в ключ и не схлопывал
 * ничего вообще.
 */
describe('вулканы: одна угроза — одна строка, истёкшее названо истёкшим', () => {
  const ROUTE = readFileSync(join(process.cwd(), 'app/api/safety/volcanic/route.ts'), 'utf-8');

  it('повторы схлопываются по СОДЕРЖАНИЮ, а не по id или времени', () => {
    // created_at в ключе — это и есть та ошибка, из-за которой дедуп молчал:
    // суточная сводка приходит новым постом, время у дублей всегда разное.
    expect(ROUTE).toMatch(/DISTINCT ON \([^)]*lower\(title\)/);
    expect(ROUTE).not.toMatch(/DISTINCT ON \([^)]*created_at/);
  });

  it('ключ регистронезависим — как в ленте главной', () => {
    // Один пункт сводки, перенабранный с другой заглавной, иначе разойдётся
    // на две строки. Тем же приёмом схлопывается лента в app/_home/data.ts.
    const HOME = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');
    expect(HOME).toMatch(/DISTINCT ON \(lower\(title\)\)/);
    expect(ROUTE).toMatch(/lower\(COALESCE\(description, ''\)\)/);
  });

  it('из группы остаётся свежайшая — она несёт актуальный срок и ссылку', () => {
    expect(ROUTE).toMatch(/ORDER BY lower\(title\)[\s\S]*?created_at DESC/);
  });

  it('схлопывание идёт ДО отсечки: иначе двадцать повторов вытеснят всё живое', () => {
    expect(ROUTE.indexOf('DISTINCT ON')).toBeLessThan(ROUTE.lastIndexOf('LIMIT'));
  });

  it('ответ говорит, действует предупреждение или это история недели', () => {
    expect(ROUTE).toMatch(/expires_at > NOW\(\)\)\s*AS active/);
  });

  it('страница отличает истёкшее и считает только действующие', () => {
    const CLIENT = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');
    expect(CLIENT).toMatch(/ev\.active === false/);
    // Счётчик в шапке раздела по всему списку обещал бы угрозы, которых нет.
    expect(CLIENT).toMatch(/volcanicActive/);
  });

  it('свой дедуп в кабинете не воскрешает: источник правды один', () => {
    const HUB = readFileSync(join(process.cwd(), 'app/hub/safety/_SafetyHubClient.tsx'), 'utf-8');
    const body = HUB.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(body, 'дедуп вернулся на клиент — он неполон после LIMIT')
      .not.toMatch(/volcanicUnique\s*=\s*useMemo/);
  });
});

describe('зоны и склонение на /safety', () => {
  const CLIENT = readFileSync(join(process.cwd(), 'app/safety/_SafetyClient.tsx'), 'utf-8');

  it('чипы зон показывают русское имя, не слаг', () => {
    // «avachinsky» на предупреждении про Мутновский читался как ошибка
    // тегирования, хотя это верная зона 4-зонной модели.
    expect(CLIENT).toMatch(/\{zoneName\(z\)\}/);
  });

  it('источник имён зон один — lib/safety/zone-names', () => {
    const summary = readFileSync(join(process.cwd(), 'app/api/public/danger-summary/route.ts'), 'utf-8');
    expect(summary).toMatch(/from '@\/lib\/safety\/zone-names'/);
    expect(summary, 'в danger-summary вернулась локальная копия имён зон')
      .not.toMatch(/avachinsky:\s*'Авачинско/);
  });

  it('счётчик сейсмики склоняется', () => {
    expect(CLIENT, '«1 событий» — счётчик снова без склонения')
      .toMatch(/plural\(seismic\.length,\s*'событие',\s*'события',\s*'событий'\)/);
  });
});
