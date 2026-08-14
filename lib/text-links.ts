/**
 * Подсветка упоминаний в чужом тексте — общий механизм для всех справочников.
 *
 * Логика родилась в DescriptionWithFishLinks: пройти текст паттернами
 * справочника, найти непересекающиеся вхождения, нарезать на куски «текст» и
 * «текст-ссылка». Когда появился второй справочник (статьи), выбор был между
 * копией этой функции и её обобщением.
 *
 * Копия здесь стоила бы дороже обычного. Тест сезонной сетки прямо об этом:
 * «Расхождение копий — ровно то, за что платили карточкой тура». Два матчера
 * разошлись бы на первом же частном случае — падеж, пересечение, регистр, — и
 * рыба в описании подсвечивалась бы иначе, чем статья в том же абзаце.
 *
 * Поэтому здесь только нарезка, без React и без знания о том, что за
 * сущность подсвечивается. Справочник обязан дать `id` и `patterns`; куда
 * ведёт ссылка и как она выглядит — дело компонента.
 */

/** Минимум, который справочник обязан дать матчеру. */
export interface Linkable {
  id: string;
  patterns: RegExp[];
}

/** Кусок текста: либо голый текст, либо совпадение с записью справочника. */
export interface LinkedChunk<T extends Linkable> {
  text: string;
  entry?: T;
}

/**
 * Нарезать текст на куски по паттернам справочника.
 *
 * Пересечения отбрасываются: первое найденное вхождение выигрывает, второе
 * поверх него не ложится — иначе ссылка оказалась бы внутри ссылки.
 *
 * `excludeId` — запись, на которую ссылаться не надо. Описание чавычи
 * упоминает чавычу, и ссылка на самого себя была бы шумом (решение владельца
 * 07.08 по страницам /fish/[id]); статьи ведут себя так же.
 */
export function linkifyText<T extends Linkable>(
  text: string,
  entries: readonly T[],
  excludeId?: string,
): LinkedChunk<T>[] {
  const matches: { start: number; end: number; matched: string; entry: T }[] = [];

  for (const entry of entries) {
    if (entry.id === excludeId) continue;
    for (const pattern of entry.patterns) {
      // Своя копия регулярки: флаг g делает exec() статфульным (lastIndex),
      // а справочник — общий и переиспользуется между вызовами.
      const re = new RegExp(pattern.source, pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (!matches.some(e => e.start < end && e.end > start)) {
          matches.push({ start, end, matched: m[0], entry });
        }
        // Пустое совпадение не двигает курсор — иначе вечный цикл.
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }

  if (matches.length === 0) return [{ text }];

  matches.sort((a, b) => a.start - b.start);

  const chunks: LinkedChunk<T>[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) chunks.push({ text: text.slice(cursor, m.start) });
    chunks.push({ text: m.matched, entry: m.entry });
    cursor = m.end;
  }
  if (cursor < text.length) chunks.push({ text: text.slice(cursor) });

  return chunks;
}

/**
 * Какие записи справочника упомянуты в тексте.
 *
 * Тот же набор паттернов, что у подсветки, — детект и ссылки не имеют права
 * расходиться: блок «по теме» обязан появляться ровно тогда, когда в тексте
 * есть то, что подсветилось бы ссылкой.
 */
export function detectLinkables<T extends Linkable>(
  text: string,
  entries: readonly T[],
): T[] {
  return entries.filter(entry =>
    entry.patterns.some(p => new RegExp(p.source, p.flags.replace('g', '')).test(text)),
  );
}
