/**
 * tests/unit/places-enricher-purged.test.ts
 *
 * Скрейпер чужих описаний мест удалён и не возвращается.
 *
 * ── Решение владельца 08.09: «конечно так же, что и с идилесом» ────────────
 *
 * Обогатитель мест ходил на extraguide.ru, tur-ray.ru и spkam.com, забирал
 * оттуда описания природных объектов, прогонял через модель «своими словами»
 * и клал результат на наши карточки мест. По роду это ровно тот же случай,
 * что idilesom (решение 07.09): чужой труд, переодетый в наш.
 *
 * Разбор того же дня нашёл у него и другие дефекты — своя мерка сходства
 * имён, гонка мелких моделей вместо качественного пути, отсутствие строки
 * происхождения. Они были починены за час до этого решения, и правка ушла
 * вместе с файлом: чинить машину, которую сносишь, смысла нет, а история
 * правки остаётся в git.
 *
 * ── Что осознанно ОСТАВЛЕНО ───────────────────────────────────────────────
 *
 *   - уже написанные описания мест. Как и с idilesom, владелец выбирал не
 *     «удалить скачанное», а «убрать машину»: снос текста оставил бы карточки
 *     пустыми, и переписывать их было бы нечем.
 *
 * ── Чего мы НЕ знаем и не выдаём за знание ────────────────────────────────
 *
 * Какие именно описания написал этот обогатитель — установить нечем. Он
 * сохранял их БЕЗ `source_url` (так было сказано в его собственной шапке) и
 * не писал строку в `description_provenance`. То есть подписи, которую у
 * idilesom чистила миграция 941, здесь не существует вовсе, и «сколько
 * карточек несут переписанный чужой текст» — честное «не знаю», а не ноль.
 * Единственная зацепка на будущее: описания, написанные Editor, помечены в
 * `description_provenance`; всё остальное — под вопросом.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const GONE = [
  'lib/agents/places-enricher.ts',
  'tests/unit/places-enricher-vs.test.ts',
  'tests/unit/places-enricher-standard.test.ts',
];

/** Хосты, ради которых машина и существовала. */
const HOSTS = ['extraguide.ru', 'tur-ray.ru', 'spkam.com'];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const rel = `${dir}/${name}`;
    const st = statSync(join(root, rel));
    if (st.isDirectory()) sourceFiles(rel, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) acc.push(rel);
  }
  return acc;
}

describe('машинерия источника удалена', () => {
  for (const f of GONE) {
    it(`нет файла: ${f}`, () => {
      expect(existsSync(join(root, f)), `${f} вернулся`).toBe(false);
    });
  }

  it('никто не зовёт обогатитель', () => {
    const hits = sourceFiles('app')
      .concat(sourceFiles('lib'), sourceFiles('scripts'))
      .filter((f) => /runPlacesEnricher|agents\/places-enricher/.test(readFileSync(join(root, f), 'utf8')));
    expect(hits, `вызов удалённого обогатителя: ${hits.join(', ')}`).toEqual([]);
  });

  it('к чужим сайтам никто не ходит', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles('app').concat(sourceFiles('lib'), sourceFiles('scripts'))) {
      const src = readFileSync(join(root, f), 'utf8');
      // Ищем именно ОБРАЩЕНИЕ — адрес в http(s)-строке, а не упоминание имени
      // хоста в тексте объяснения (иначе этот же сторож запретил бы объяснять,
      // почему машина удалена).
      for (const host of HOSTS) {
        if (new RegExp(`https?://(www\\.)?${host.replace('.', '\\.')}`).test(src)) {
          offenders.push(`${f} → ${host}`);
        }
      }
    }
    expect(offenders, `скрейп чужого сайта вернулся: ${offenders.join(', ')}`).toEqual([]);
  });

  it('у крон-роута импорта не осталось режима places', () => {
    const src = readFileSync(join(root, 'app/api/cron/import-routes/route.ts'), 'utf8');
    expect(src).not.toMatch(/source === 'places'/);
  });
});
