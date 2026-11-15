/**
 * Заглушка общей сборки данных хода Кузьмича (`kuzmichTurnFacts`,
 * `kuzmichSystemContent`) для тестов роутов, которые подменяют
 * `@/lib/kuzmich/core` целиком: в них запросы к базе расписаны по порядку, и
 * настоящая сборка сбила бы очередь ответов.
 *
 * Данных хода нет; инструкция — `persona` (то, чем тест подменил
 * KUZMICH_SYSTEM), затем строки поверхности (план разговора, место человека,
 * память). Настоящую сборку на всех поверхностях держит
 * tests/unit/kuzmich-same-facts-all-surfaces.test.ts.
 */
export function kuzmichTurnStub(persona: string) {
  return {
    kuzmichTurnFacts: async () => ({ tourContext: '', mchsBlock: '', facts: '' }),
    kuzmichSystemContent: (_turn: unknown, opts: { base?: string; lead?: string[]; tail?: string[] } = {}) => {
      const dynamic = [...(opts.lead ?? []), ...(opts.tail ?? [])].filter(Boolean).join('\n\n');
      return { system: [opts.base ?? persona, dynamic].filter(Boolean).join('\n\n'), dynamic, guardContext: dynamic };
    },
  };
}
