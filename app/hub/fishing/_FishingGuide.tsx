import Link from 'next/link';

/**
 * Справочный блок посадочной «Рыбалка» (01.11, «усилимся»): сезоны по видам,
 * как оставить заявку через Ведар/Кузьмича, FAQ. Только общеизвестные факты о
 * сезонах лосося; цены — из живых туров (minPrice), не выдуманные.
 */
export const FISHING_SEASONS: { fish: string; months: string; note: string }[] = [
  { fish: 'Чавыча (королевский лосось)', months: 'июнь — середина июля', note: 'самый крупный лосось, трофей от 8 кг' },
  { fish: 'Нерка', months: 'июнь — август', note: 'ход в реки и озёра, яркая окраска на нересте' },
  { fish: 'Горбуша и кета', months: 'июль — август', note: 'массовый ход, частые поклёвки — хорошо для новичков' },
  { fish: 'Кижуч', months: 'август — октябрь (поздний — до ноября)', note: 'сильная рыба, осенний сезон' },
  { fish: 'Микижа, голец, кунджа, хариус', months: 'весь сезон открытой воды', note: 'нахлыст и спиннинг; часть водоёмов — только «поймал-отпустил»' },
  { fish: 'Зимняя рыбалка со льда', months: 'с ноября до весны', note: 'голец, корюшка, навага — по льду с проводником' },
];

export const FISHING_FAQ: { q: string; a: string }[] = [
  { q: 'Когда лучше ехать на рыбалку на Камчатку?', a: 'Чавыча — июнь и первая половина июля; нерка, кета и горбуша — июль–август; кижуч — с конца августа по октябрь. Зимой рыбачат со льда.' },
  { q: 'Сколько стоит рыболовный тур на Камчатке?', a: 'Цены задают операторы: на Ведаре у каждого тура указана цена, что входит и что оплачивается отдельно (часто — трансфер до базы и лицензия). Актуальные цены — в карточках туров на этой странице.' },
  { q: 'Нужна ли лицензия на рыбалку?', a: 'Для изъятия лосося нужна путёвка/лицензия; обычно её оформляет оператор тура. Уточняйте в карточке тура, входит ли она в стоимость.' },
  { q: 'Как забронировать рыболовный тур через Ведар?', a: 'Откройте тур, выберите дату со свободными местами, укажите число участников, имя и телефон — заявка уйдёт оператору, он подтвердит дату. Оплата — напрямую оператору, Ведар платежей не берёт. Можно попросить Кузьмича подобрать тур и оставить заявку в чате.' },
  { q: 'Можно ли совместить рыбалку с проживанием и трансфером?', a: 'Да: Кузьмич или MCP-агент оформит одну поездку — тур, жильё и машину под заказ; каждую часть подтверждает свой партнёр.' },
];

export function fishingFaqJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FISHING_FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
}

export function FishingGuide() {
  return (
    <div className="ds-page px-0 mt-10 space-y-10 text-[var(--text-secondary)]">
      <section>
        <h2 className="ds-h2 mb-4">Сезоны рыбалки на Камчатке по видам рыбы</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[var(--text-primary)]"><th className="py-2 pr-4">Рыба</th><th className="py-2 pr-4">Когда</th><th className="py-2">Особенности</th></tr></thead>
            <tbody>
              {FISHING_SEASONS.map(s => (
                <tr key={s.fish} className="border-t border-[var(--border)]"><td className="py-2 pr-4 font-medium text-[var(--text-primary)]">{s.fish}</td><td className="py-2 pr-4">{s.months}</td><td className="py-2">{s.note}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs">Сроки хода зависят от года и реки — точные даты заездов задаёт оператор в карточке тура.</p>
      </section>

      <section>
        <h2 className="ds-h2 mb-4">Как забронировать рыболовный тур на Камчатку</h2>
        <ol className="list-decimal pl-5 space-y-2 text-sm">
          <li>Выберите тур выше или <Link className="underline" href="/catalog">в каталоге туров Камчатки</Link>.</li>
          <li>В карточке тура выберите дату — показаны только даты со свободными местами.</li>
          <li>Укажите число участников, имя и телефон — заявка уйдёт оператору напрямую.</li>
          <li>Оператор подтвердит дату; оплата — ему напрямую, без комиссии для туриста.</li>
        </ol>
        <p className="mt-3 text-sm">
          Не знаете, что выбрать? <Link className="underline" href="/?ask=Хочу+на+рыбалку+на+Камчатке,+подбери+тур">Спросите Кузьмича</Link> — он подберёт тур под даты и оставит заявку в чате. Также пригодятся: <Link className="underline" href="/accommodations">жильё</Link>, <Link className="underline" href="/transfers">трансферы до базы</Link>, <Link className="underline" href="/safety">безопасность на реке</Link>, <Link className="underline" href="/operators">операторы Камчатки</Link>.
        </p>
      </section>

      <section>
        <h2 className="ds-h2 mb-4">Частые вопросы о рыбалке на Камчатке</h2>
        <div className="space-y-4">
          {FISHING_FAQ.map(({ q, a }) => (
            <div key={q}><h3 className="font-semibold text-[var(--text-primary)] mb-1">{q}</h3><p className="text-sm leading-relaxed">{a}</p></div>
          ))}
        </div>
      </section>
    </div>
  );
}
