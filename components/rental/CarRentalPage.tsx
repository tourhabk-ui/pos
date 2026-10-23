/**
 * /car-rental — аренда автомобилей на Камчатке: машина без водителя за сутки
 * (решение владельца 23.10: «пока берем аренду автомобилей и трансфер»).
 *
 * Прокат — не перевозчик (§14): там машина целиком с водителем на направление,
 * здесь — машина без водителя, цена за сутки по прайсу прокатчика; направление
 * и дни задаёт арендатор, водитель — по желанию и за отдельную плату, которой
 * прайс не называет. Поэтому витрина своя, а не вкладка /transfers; ссылка
 * туда — для того, кому нужна машина с водителем целиком.
 *
 * Сверху вниз: шапка (одна строка сути на телефоне) → прокатчики с прайсом
 * (три исхода: есть / нет — словами / не прочитались — «сбой, это не значит,
 * что их нет») → как заказать → Кузьмич. Компонент без хуков: страница
 * рисуется на сервере.
 *
 * Порядок прокатчиков — по алфавиту, одно правило для всех, и оно названо на
 * странице: место в списке не продаётся (CLAUDE.md §0, владелец 15.10).
 */

import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import BottomNav from '@/components/shared/BottomNav';
import KuzmichContacts from '@/components/shared/KuzmichContacts';
import { RentalCompanyCard } from '@/components/rental/RentalCompanyCard';
import { RENTAL_ORDER_NOTE } from '@/lib/operators/order-note';
import type { RentalState } from '@/lib/rental/rental-format';

export function CarRentalPage({ rental }: { rental: RentalState }) {
  return (
    <div className="ds-page" style={{ paddingBottom: 96 }}>
      <Header />
      <main className="mx-auto max-w-2xl px-5 pt-6">
        {/* SOS — в общей шапке (Header, §2), своей копии рядом с заголовком нет. */}
        {/* Шапка — по образцу /transfers: заголовок 28px на телефоне, одна
            строка сути, подробности — только с sm. */}
        <div className="mb-6">
          <p className="ds-label mb-1 sm:mb-2">Прокат</p>
          <h1 className="font-playfair text-[28px] sm:text-4xl font-bold text-[var(--text-primary)] leading-tight mb-1 sm:mb-2">Аренда автомобилей</h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-md">
            Машина без водителя — по прайсу прокатчика, цена за сутки за машину.
            <span className="hidden sm:inline">
              {' '}Куда ехать и на сколько дней решаете вы; заявку менеджер Ведара подтверждает с прокатчиком.
            </span>
          </p>
        </div>

        <section aria-labelledby="rental-title" className="mb-10">
          <h2 id="rental-title" className="ds-h2 mb-3">Машины напрокат</h2>
          {rental.state === 'failed' ? (
            <div className="ds-card p-4 flex items-start gap-2 border-[var(--warning)]">
              <AlertCircle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm text-[var(--text-primary)]">Не смогли проверить прокат автомобилей</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">Сбой на нашей стороне. Это не значит, что их нет — загляните позже.</p>
              </div>
            </div>
          ) : rental.companies.length > 0 ? (
            <>
              {/* Правило порядка — словами (§0): по алфавиту, одно для всех. */}
              <p className="text-xs text-[var(--text-muted)] mb-3">{RENTAL_ORDER_NOTE}</p>
              <div className="flex flex-col gap-4">
                {rental.companies.map((c) => <RentalCompanyCard key={c.partnerId} company={c} />)}
              </div>
            </>
          ) : rental.pausedReturnsOn ? (
            // Прокатчик есть, его прячет пауза (слово владельца 23.10), — не «прокатчиков нет».
            <p className="text-sm text-[var(--text-secondary)]">Прокат вернётся на витрину {rental.pausedReturnsOn}.</p>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">Прокатчиков с прайсом пока нет.</p>
          )}
        </section>

        <section aria-labelledby="how-title" className="mb-10">
          <h2 id="how-title" className="ds-h2 mb-3">Как заказать</h2>
          <ol className="space-y-2 text-sm text-[var(--text-secondary)] list-decimal pl-5">
            <li>Цена в прайсе — за сутки за машину без водителя, как её записал прокатчик; «от» значит, что точную назовёт он сам.</li>
            <li>Нажмите «Заказать» у машины — откроется заявка на странице прокатчика, машина уже выбрана; укажите даты, имя и телефон.</li>
            <li>Менеджер Ведара подтвердит машину с прокатчиком. Расчёт — напрямую с ним: через платформу машина не оплачивается.</li>
          </ol>
          <p className="text-sm text-[var(--text-secondary)] mt-4">
            Нужна машина с водителем целиком —{' '}
            <Link href="/transfers" className="text-[var(--ocean)] hover:underline">трансферы</Link>.
          </p>
        </section>

        <KuzmichContacts className="mb-10" />
      </main>
      <BottomNav activePath="/car-rental" />
    </div>
  );
}
