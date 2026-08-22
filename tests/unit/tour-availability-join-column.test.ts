/**
 * tour_availability связывается с туром ТОЛЬКО через operator_tour_id.
 *
 * Находка эволюции #1331 (22.08): в lib/agents/sdk/operator-tools.ts стоял
 * `LEFT JOIN tour_availability ta ON ta.tour_id = ot.id`. Колонки `tour_id`
 * у этой таблицы на проде НЕТ — миграция 040 завела `operator_tour_id`, и
 * снимок живой БД (lib/database/baseline) это подтверждает. Запрос падал бы
 * с `column does not exist`.
 *
 * Общий гард фантомных колонок это пропустил, и вот почему: реестр схемы
 * собирается из migrations/ И lib/database/, а в lib/database/schema.sql
 * лежит МЁРТВОЕ определение той же таблицы (`tour_id UUID REFERENCES
 * tours(id)` — с запрещённой в проекте таблицей `tours`). Реестр сливает оба
 * определения, и фантом числится существующим. Замер 22.08: если убрать
 * мёртвую схему из реестра — 2088 ложных находок (она единственный источник
 * для users/partners/places); если брать первое CREATE — 1894. То есть
 * правильный источник это baseline прода, и переезд на него — отдельная
 * работа, а не попутная правка.
 *
 * Пока её нет, здесь стоит узкий сторож на конкретную таблицу: она слишком
 * дорого стоит (занятость туров = деньги), чтобы ждать общего решения.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Значение из разбора — в шаблон только экранированным. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const ROOT = process.cwd();

/** Код без комментариев: и блочных, и строчных, и SQL-строчных внутри запроса. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/^\s*--.*$/gm, ' ');
}

describe('tour_availability: связь с туром', () => {
  it('нигде в app/ и lib/ нет JOIN по фантомной tour_id', () => {
    const files = execSync(`git ls-files 'app/**/*.ts' 'lib/**/*.ts'`, { cwd: ROOT, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const f of files) {
      // Комментарии убираем ДО разбора: строка «operator_tour_id, а НЕ
      // ta.tour_id», объясняющая правило, сама не является нарушением.
      // Сторож, читающий пояснения как код, ловит того, кто их написал.
      const src = stripComments(readFileSync(join(ROOT, f), 'utf-8'));
      // Ищем алиас, которым назвали tour_availability, и проверяем, по какой
      // колонке его джойнят. Своё правило именования тут не изобретаем —
      // берём алиас прямо из текста запроса.
      for (const m of src.matchAll(/tour_availability\s+(?:AS\s+)?([a-zA-Z_]\w*)/gi)) {
        const alias = m[1];
        const joinOnPhantom = new RegExp(`\\b${escapeRe(alias)}\\.tour_id\\b`);
        if (joinOnPhantom.test(src)) offenders.push(`${f} → ${alias}.tour_id`);
      }
    }

    expect(offenders, 'tour_availability джойнится по operator_tour_id, колонки tour_id у неё нет').toEqual([]);
  });

  it('в снимке живой БД у таблицы есть operator_tour_id и нет tour_id', () => {
    // Baseline снят с прода — это и есть истина, в отличие от реестра миграций.
    const baseline = readFileSync(join(ROOT, 'lib/database/baseline/schema-baseline.sql'), 'utf-8');
    const body = baseline.slice(baseline.indexOf('CREATE TABLE IF NOT EXISTS tour_availability'));
    const create = body.slice(0, body.indexOf('\n);'));
    expect(create).toMatch(/^\s+operator_tour_id\s/m);
    expect(create).not.toMatch(/^\s+tour_id\s/m);
  });
});
