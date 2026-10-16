/**
 * /transfers — трансфер на Камчатке: машина целиком под заказ (владелец 13.10:
 * «у нас не правильная логика бронируют целую машину а не место в ней»).
 *
 * До этого витрина продавала «места в поездках»: форма дат и список
 * поездок, где перевозчик выставляет свободные места. Такого товара нет —
 * машину заказывают целиком: направление и даты задаёт заказчик, цена — за
 * машину по прайсу перевозчика. Модуль мест (схема 926) спрятан, а не удалён:
 * его роуты остаются, но ни одна поверхность их не показывает.
 *
 * Сверху вниз: шапка (одна строка сути на телефоне) → перевозчики с прайсом
 * (три исхода: есть / нет — словами / не прочитались — «сбой, это не значит,
 * что их нет») → как заказать. Компонент без хуков: страница рисуется на
 * сервере.
 *
 * Порядок перевозчиков — по алфавиту, одно правило для всех, и оно названо
 * на странице: место в списке не продаётся (CLAUDE.md §0, владелец 15.10).
 * Перевозчиков стало двое — у «ИП Желтухин» цена за час и за день, а не по
 * направлениям, поэтому и «Как заказать» говорит о прайсе, а не только о
 * направлении.
 */

import { AlertCircle } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import { CharterCard } from '@/components/transfers/CharterCard';
import { CARRIERS_ORDER_NOTE } from '@/lib/operators/order-note';
import type { CharterState } from '@/lib/transfers/charter-format';

export function TransfersPage({ charter }: { charter: CharterState }) {
  return (
    <div className="ds-page" style={{ paddingBottom: 96 }}>
      <Header />
      <main className="mx-auto max-w-2xl px-5 pt-6">
        {/* SOS — в общей шапке (Header, §2), своей копии рядом с заголовком нет. */}
        {/* Шапка — по образцу каталога туров (владелец 12.10): заголовок 28px
            на телефоне, одна строка сути, подробности — только с sm. */}
        <div className="mb-6">
          <p className="ds-label mb-1 sm:mb-2">Перевозчики</p>
          <h1 className="font-playfair text-[28px] sm:text-4xl font-bold text-[var(--text-primary)] leading-tight mb-1 sm:mb-2">Трансферы</h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-md">
            Машина целиком под заказ — по прайсу перевозчика, цена за машину.
            <span className="hidden sm:inline">
              {' '}Направление и даты задаёте вы; заявку менеджер Ведара подтверждает с перевозчиком.
            </span>
          </p>
        </div>

        <section aria-labelledby="charter-title" className="mb-10">
          <h2 id="charter-title" className="ds-h2 mb-3">Машина под заказ</h2>
          {charter.state === 'failed' ? (
            <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
              <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm text-[var(--text-primary)]">Не смогли проверить машины под заказ</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">Сбой на нашей стороне. Это не значит, что их нет — загляните позже.</p>
              </div>
            </div>
          ) : charter.carriers.length > 0 ? (
            <>
              {/* Правило порядка — словами (§0): по алфавиту, одно для всех. */}
              <p className="text-xs text-[var(--text-muted)] mb-3">{CARRIERS_ORDER_NOTE}</p>
              <div className="flex flex-col gap-4">
                {charter.carriers.map(c => <CharterCard key={c.partnerId} carrier={c} />)}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">Перевозчиков с прайсом под заказ пока нет.</p>
          )}
        </section>

        <section aria-labelledby="how-title" className="mb-10">
          <h2 id="how-title" className="ds-h2 mb-3">Как заказать</h2>
          <ol className="space-y-2 text-sm text-[var(--text-secondary)] list-decimal pl-5">
            <li>Нажмите «Заказать» у направления в прайсе или у цены за час и за день — цена за машину целиком, сколько бы вас ни было в пределах мест.</li>
            <li>Оставьте заявку на машину на странице перевозчика: дата выезда, сколько человек, телефон — направление уже выбрано, а у цены за время работы его пишете вы.</li>
            <li>Менеджер Ведара подтвердит машину с перевозчиком. Расчёт — напрямую с ним: через платформу машина не оплачивается.</li>
          </ol>
        </section>
      </main>
      <BottomNav activePath="/transfers" />
    </div>
  );
}
