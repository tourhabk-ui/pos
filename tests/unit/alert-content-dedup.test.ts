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
      .toMatch(/UPDATE external_alerts[\s\S]*?alert_type = \$1 AND title = \$2[\s\S]*?COALESCE\(description, ''\) = COALESCE\(\$3, ''\)[\s\S]*?expires_at > NOW\(\)/);
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
    expect(body).toMatch(/rowCount \?\? 0\) > 0\) return 'skipped'/);
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
