'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { TourForm } from '@/components/operator/Tours/TourForm';
import { TourFormData } from '@/types/operator';
import { useAuth } from '@/contexts/AuthContext';
import toast from 'react-hot-toast';
import { categoryToTourTypes } from '@/lib/tours/form-category';

export default function NewTourClient() {
  const { user } = useAuth();
  const router = useRouter();

  const handleSubmit = async (formData: TourFormData, routeTitle?: string) => {
    const response = await fetch('/api/hub/operator/tours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:            formData.name,
        description:      formData.description,
        // Категория — ЧТО за тур (тип активности и местности), а не ГДЕ:
        // до 25.09 слаг «rybalka» уходил в location_name и виделся туристу.
        ...categoryToTourTypes(formData.category),
        // Где — берётся из выбранного маршрута; без него честно «край», без
        // выдуманных координат (53.0/158.7 стояли у каждого нового тура).
        location_name:    routeTitle ?? 'Камчатский край',
        base_price:       formData.price,
        price_unit:       'per_person',
        max_participants: formData.maxGroupSize,
        min_participants: formData.minGroupSize,
        duration_hours:   formData.duration,
        difficulty:       formData.difficulty,
        included:         formData.includes as string[],
        not_included:     formData.excludes as string[],
        tour_image:       formData.tourImage || undefined,
        // Маршрут тура — route_id (по нему карточка находит трек); в
        // agent_route_id он уходил мимо, и связь терялась.
        route_id:         formData.routeId   || undefined,
      }),
    });

    const result = await response.json() as { success: boolean; error?: string };

    if (!result.success) {
      throw new Error(result.error ?? 'Ошибка создания тура');
    }

    toast.success('Тур успешно создан!');
    router.push('/hub/operator/tours');
  };

  const handleCancel = () => {
    router.push('/hub/operator/tours');
  };

  return (
    <div className="p-5 lg:p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">
          Создание нового тура
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">
          Заполните информацию о туре
        </p>
      </div>

      {/* Content */}
      <TourForm
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        isEdit={false}
      />
    </div>
  );
}
