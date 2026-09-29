/**
 * Лента «Исследовать» на главной: разные места, а не восемь вулканов подряд.
 *
 * Повод (владелец, 29.09: «оживил на главной блок места, но там только
 * вулканы»). Лента берёт выдачу каталога мест в порядке `recommended` —
 * и первые восемь в нём сейчас все вулканы, хотя в той же выдаче есть
 * источники, озёра, скалы, водопады.
 *
 * Своей сортировки здесь нет — порядок каталога остаётся законом ВНУТРИ
 * каждого типа. Меняется только раскладка: типы идут по очереди в том
 * порядке, в каком каталог впервые их показал (самый рекомендуемый тип —
 * первым), и из каждого берётся следующее по порядку место. Типов меньше,
 * чем мест в ленте, — круг идёт заново; места кончились — берутся из
 * оставшихся типов.
 *
 * Место без типа (`locationType` null) — отдельная группа, а не «вулкан по
 * умолчанию»: придумывать тип нельзя (§4.0).
 */
export function varietyByType<T extends { locationType: string | null }>(items: readonly T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const key = it.locationType ?? '\u0000unknown';
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      if (out.length >= limit) break;
      const next = q.shift();
      if (next) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}
