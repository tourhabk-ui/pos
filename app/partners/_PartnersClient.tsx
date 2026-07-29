'use client';

import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import YandexTravelBlock from '@/components/routes/YandexTravelBlock';
import RouteAffiliateBlock from '@/components/routes/RouteAffiliateBlock';

export default function PartnersClient() {
  return (
    <div className="bg-[var(--bg-primary)] text-[var(--text-primary)] min-h-[100dvh]">
      <Header />

      <main className="pt-16">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section className="ds-section border-b border-[var(--border)]">
          <div className="max-w-3xl">
            <p className="text-xs uppercase tracking-widest text-[var(--text-muted)] mb-3">Планирование</p>
            <h1 className="ds-h1 font-playfair mb-4">Всё для поездки на Камчатку</h1>
            <p className="text-[var(--text-secondary)] text-lg leading-relaxed">
              Авиабилеты, отели, трансферы и страховка — партнёрские сервисы, которые мы рекомендуем туристам платформы.
            </p>
          </div>
        </section>

        {/* ── Блоки ────────────────────────────────────────────────────────── */}
        <section className="ds-section">
          <div className="max-w-4xl space-y-0">

            {/* Яндекс Путешествия — полная ширина; убираем border-t первого блока */}
            <div className="[&>section]:border-t-0 [&>section]:pt-0 [&>section]:mt-0">
              <YandexTravelBlock source="partners_page" />
            </div>

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
      </main>

      <Footer />
    </div>
  );
}
