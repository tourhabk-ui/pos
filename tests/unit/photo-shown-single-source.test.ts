/**
 * Сторож: условие показа снимка живёт в одном месте (18.09).
 *
 * ── Что случилось ─────────────────────────────────────────────────────────
 *
 * Владелец: «куда делись фотки вулканов, почему почти все места без фото».
 * Перепись с прода: снимков 657, показывается 50. Среди скрытых — 103
 * НАСТОЯЩИЕ фотографии (`real-photo` 81, `wikimedia-commons` 22), которых
 * никто не решал прятать: их род просто не совпал со строкой в фильтре.
 *
 * Фильтр был написан литералом `model IN ('wikimedia','manual-upload')` в
 * тринадцати файлах. Комментарий рядом говорил «AI-генерации не показываем»
 * (решение владельца 17.07) — и это было правдой наполовину: заодно он прятал
 * снимки владельца. Описание разошлось с кодом, а код — с данными.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Правило одно, значит и место одно. Литерал в любом файле, кроме реестра, —
 * это начало тринадцатого расхождения, и тест краснеет на первом же.
 *
 * Отдельно проверяется ФОРМА имён: SHOWN_MODELS вшивается в текст запроса, и
 * безопасность этого держится ровно на том, что внутри только латиница и
 * дефис. Появится там кавычка или пробел — краснеет здесь, а не на проде.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SHOWN_MODELS, KEEP_MODELS, shownPhotoSql, isGenerated } from '@/lib/images/origin';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const ROOT = process.cwd();
const SCAN_DIRS = ['app', 'lib'];
const REGISTRY = 'lib/images/origin.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('список показываемых снимков — один', () => {
  it('литерал фильтра не повторяется нигде, кроме реестра', () => {
    // Ровно та форма, что лежала в тринадцати файлах: перечисление родов
    // прямо в тексте запроса.
    const literal = /'wikimedia'\s*,\s*'manual-upload'/;
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === REGISTRY) continue;
        if (literal.test(readFileSync(file, 'utf-8'))) offenders.push(rel);
      }
    }
    expect(offenders, 'условие показа обязано браться из SHOWN_MODELS, а не переписываться заново').toEqual([]);
  });

  it('пачка real-photo НЕ показывается: подпись владельца снята 03.10', () => {
    // 978 подписала её владельцем по слову 18.09 о ДРУГИХ снимках; 03.10
    // владелец: «я их точно не загружал». Без автора и источника — не показ.
    expect(SHOWN_MODELS).not.toContain('real-photo');
    expect(KEEP_MODELS).toContain('real-photo');
    expect(read('migrations/1150_real_photo_authorship_revoked.sql')).toMatch(/SET author = NULL\s+WHERE model = 'real-photo'\s+AND author = 'владелец платформы'/);
  });

  it('чужие wikimedia-commons НЕ показываются, пока не подписаны', () => {
    // 22 снимка с чужой лицензией и пустым автором. Внесут сюда — тест
    // краснеет, и это правильно: сначала авторство, потом показ.
    expect(SHOWN_MODELS).not.toContain('wikimedia-commons');
  });

  it('показываемое и сгенерированное не пересекаются', () => {
    // Иначе решение 17.07 («честный градиент вместо AI-фото») отменилось бы
    // молча, одной строкой в другом списке.
    const both = SHOWN_MODELS.filter((m) => isGenerated(m));
    expect(both, 'род не может быть одновременно показываемым и машинным').toEqual([]);
  });
});

describe('предикат безопасен по построению', () => {
  it('имена родов — только латиница и дефис', () => {
    // На этом и только на этом держится право вшивать список в текст запроса.
    for (const m of SHOWN_MODELS) expect(m).toMatch(/^[a-z][a-z-]*$/);
  });

  it('предикат подставляет переданное выражение и перечисляет все роды', () => {
    const sql = shownPhotoSql('ai.model');
    expect(sql).toBe("ai.model IN ('wikimedia', 'manual-upload')");
  });
});
