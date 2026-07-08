'use client';

import { User } from 'lucide-react';
import PartnerProfileEditor from '@/components/hub/PartnerProfileEditor';

/**
 * Страница «Профиль» агентского кабинета — редактирование профиля/контактов
 * через общий PartnerProfileEditor (GET/PATCH /api/partners/profile).
 */
export default function AgentProfileClient() {
  return (
    <div className="p-5 lg:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <User className="w-4 h-4 text-[var(--text-muted)]" />
        <h1 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">Профиль агентства</h1>
      </div>
      <PartnerProfileEditor namePlaceholder="Турагентство «Восток»" />
    </div>
  );
}
