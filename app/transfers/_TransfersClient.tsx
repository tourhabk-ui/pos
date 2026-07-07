'use client';

import { Bus } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { TransferSearchWidget } from '@/components/transfer-operator/TransferSearchWidget';

/**
 * Публичная страница трансферов: поиск и бронирование через рабочий
 * TransferSearchWidget (/api/transfers/search|book). Раньше пункт
 * «Трансферы» публичной навигации вёл на /hub/transfer — мок-дашборд
 * с фиктивными данными и кнопками без обработчиков.
 */
export default function TransfersClient() {
  return (
    <>
      <Header />
      <div className="ds-page pt-20 pb-16">
        <div className="max-w-2xl mx-auto">
          <div className="mb-6">
            <div className="flex items-center gap-2.5 mb-1">
              <Bus className="w-6 h-6 text-[var(--ocean)]" />
              <h1 className="ds-h1">Трансферы</h1>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">
              Аэропорт Елизово, Петропавловск-Камчатский, стартовые точки маршрутов.
              Выберите направление и дату — покажем доступные машины и цены.
            </p>
          </div>

          <TransferSearchWidget />
        </div>
      </div>
    </>
  );
}
