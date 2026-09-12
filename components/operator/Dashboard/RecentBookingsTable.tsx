'use client';

import React from 'react';
import { DataTable, StatusBadge, Column } from '@/components/admin/shared';
import { OperatorBooking } from '@/types/operator';

interface RecentBookingsTableProps {
  bookings: OperatorBooking[];
}

export function RecentBookingsTable({ bookings }: RecentBookingsTableProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      minimumFractionDigits: 0
    }).format(value);
  };

  const getStatusType = (status: string) => {
    switch (status) {
      case 'confirmed':
        return 'success';
      case 'pending':
        return 'warning';
      case 'cancelled':
        return 'error';
      case 'completed':
        return 'info';
      default:
        return 'pending';
    }
  };

  const columns: Column<OperatorBooking>[] = [
    {
      key: 'id',
      title: 'ID',
      width: '100px',
      render: (booking) => (
        <span className="text-[var(--text-muted)] font-mono text-xs">
          #{booking.id.substring(0, 8)}
        </span>
      )
    },
    {
      key: 'tourName',
      title: 'Тур',
      render: (booking) => (
        <div>
          <p className="font-semibold text-[var(--text-primary)]">{booking.tourName}</p>
          <p className="text-xs text-[var(--text-muted)]">
            {new Date(booking.date).toLocaleDateString('ru-RU', {
              day: 'numeric',
              month: 'short',
              year: 'numeric'
            })}
          </p>
        </div>
      )
    },
    {
      key: 'userName',
      title: 'Клиент',
      render: (booking) => (
        <div>
          <p className="text-[var(--text-primary)]">{booking.userName}</p>
          <p className="text-xs text-[var(--text-muted)]">{booking.userEmail}</p>
        </div>
      )
    },
    {
      key: 'guestsCount',
      title: 'Гости',
      render: (booking) => (
        <span className="text-[var(--text-secondary)]">
          <span className="text-xl mr-1"></span>
          {booking.guestsCount}
        </span>
      )
    },
    {
      key: 'totalPrice',
      title: 'Сумма',
      render: (booking) => (
        <span className="font-semibold text-[var(--accent)]">
          {formatCurrency(booking.totalPrice)}
        </span>
      )
    },
    {
      key: 'status',
      title: 'Статус',
      render: (booking) => (
        <StatusBadge status={getStatusType(booking.status)} />
      )
    },
    {
      key: 'createdAt',
      title: 'Дата заказа',
      render: (booking) => (
        <span className="text-[var(--text-muted)] text-sm">
          {new Date(booking.createdAt).toLocaleDateString('ru-RU')}
        </span>
      )
    }
    // Столбец «Действия» с кнопкой «Детали» убран 11.09 (#1785, решение
    // владельца «пока убери»): onViewDetails на вызывающей стороне
    // (_OperatorDashboardClient.tsx) был `(_booking) => {}` — кнопка ничего
    // не делала ни разу. Возвращать её стоит вместе с настоящим действием
    // (модалка деталей, переход на страницу брони), а не раньше.
  ];

  return <DataTable columns={columns} data={bookings} />;
}



