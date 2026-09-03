/**
 * Сравнение двух строк за постоянное время — без единого импорта.
 *
 * Зачем отдельный модуль, когда есть `lib/security/timing-safe.ts`: тот
 * тянет `crypto` из Node на уровне модуля и в Edge-бандл (middleware.ts) не
 * попадает. `lib/auth/cron.ts` держал такой же цикл у себя; теперь цикл один
 * и живёт здесь, а оба читателя — Node и Edge — зовут его.
 *
 * Разная длина возвращает false сразу. Это раскрывает ДЛИНУ ожидаемого
 * секрета, не его содержимое — тот же компромисс, что и в Node-версии, где
 * `timingSafeEqual` на буферах разной длины бросает исключение.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
