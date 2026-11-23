import type { Metadata } from 'next'
import { Header } from '@/components/layout/Header'
import { OperatorPromo } from '@/components/homepage/OperatorPromo'
import { AgentModelSection, type CatalogCounts } from '@/components/homepage/AgentModelSection'
import { getPlatformCounts } from '@/lib/stats/platform-counts'

// Рендер на каждый запрос: сборка Docker идёт без базы, и собранная там
// страница отдавала бы запечённое «чисел нет» до следующей сборки.
// Сторож: tests/unit/no-build-time-db.test.ts.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  alternates: { canonical: '/for-operators' },
  title: 'Для туроператоров Камчатки — партнёрская программа',
  description: 'Кузьмич для туроператоров Камчатки: приём обращений, квалификация лидов, подбор туров и PDF-предложения. Оплату туристы вносят вам напрямую.',
}

export default async function ForOperatorsPage() {
  /*
   * Числа маршрутов и туров — из базы, из того же источника, что главная и
   * /operators/join. До 23.11 здесь стояло «131 маршрутов в базе знаний» и
   * «13 туров в каталоге» текстом в вёрстке (живых туров было 81). Не смогли
   * посчитать — чисел нет вовсе, а не выдуманные.
   */
  let catalog: CatalogCounts | null = null
  try {
    const counts = await getPlatformCounts()
    catalog = { routes: counts.routes, tours: counts.storefrontTours }
  } catch (err) {
    console.error('[for-operators] счётчики не получены', err instanceof Error ? err.message : String(err))
  }
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />
      <main className="pt-16">
        <OperatorPromo headingLevel="h1" />
        <AgentModelSection catalog={catalog} />
      </main>
    </div>
  )
}
