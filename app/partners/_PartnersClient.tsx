'use client';

import { Header } from '@/components/layout/Header';
import Link from 'next/link';
import RouteAffiliateBlock from '@/components/routes/RouteAffiliateBlock';
import { PARTNERS_MENU, PLANNER_NAME, PLANNING_MENU, PLANS_MENU } from '@/lib/navigation/tool-names';

export default function PartnersClient() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />

      <main className="pt-16">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section className="ds-section border-b border-[var(--border)]">
          <div className="max-w-3xl">
            <p className="text-xs uppercase tracking-widest text-[var(--text-muted)] mb-3">{PARTNERS_MENU}</p>
            <h1 className="ds-h1 font-playfair mb-4">Всё для поездки на Камчатку</h1>
            <p className="text-[var(--text-secondary)] text-lg leading-relaxed">
              Авиабилеты, отели, трансферы и страховка — партнёрские сервисы, которые мы рекомендуем туристам платформы.
            </p>
          </div>
        </section>

        {/* ── Блоки ────────────────────────────────────────────────────────── */}
        <section className="ds-section">
          <div className="max-w-4xl space-y-0">

            {/* Яндекс Путешествия сняты 04.10: ООО «Яндекс.Вертикали»
                прекратило соглашение о распространении продуктов в тестовом
                режиме (п. 7.3.3). Ссылки с clid и erid по договору, которого
                нет, — неоплачиваемые переходы и реклама без основания. */}
            {/* Авиабилеты, отели, жильё, страховка, трансферы, экскурсии — один
                блок с настоящими партнёрскими ссылками. Раньше здесь стояли
                четыре отдельных блока с ВЫДУМАННЫМИ ценами, отелями и
                трансферами (в том числе «трансфер на Курильское озеро за
                5000 ₽», куда автомобильной дороги нет), без маркировки рекламы
                и с неработающими партнёрскими параметрами. Удалены: на
                платформе, которая обещает не врать цифрами, придуманный прайс
                хуже пустого места. */}
            <RouteAffiliateBlock routeId="partners_page" />

          </div>
        </section>

        {/* Перелинковка (Сыщик 22.11): билеты и отели — часть поездки, дальше —
            сама программа. */}
        <section className="ds-section border-t border-[var(--border)]" aria-label="Что дальше">
          <div className="max-w-3xl space-y-2 text-[var(--text-secondary)]">
            <h2 className="ds-h2 text-[var(--text-primary)]">Что дальше</h2>
            <ul className="space-y-1.5">
              <li><Link href="/planner" className="text-[var(--ocean)] hover:underline">{PLANNER_NAME}</Link> — план по дням с турами местных операторов, сохраняется в личном кабинете.</li>
              <li><Link href="/plans" className="text-[var(--ocean)] hover:underline">{PLANS_MENU}</Link> — маршруты по дням на 5, 7, 10 и 14 дней.</li>
              <li><Link href="/planning" className="text-[var(--ocean)] hover:underline">{PLANNING_MENU}</Link> — чек-лист снаряжения и карта без интернета для самостоятельного выхода.</li>
            </ul>
          </div>
        </section>
      </main>

    </div>
  );
}
