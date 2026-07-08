'use client';

import PartnerProfileEditor from '@/components/hub/PartnerProfileEditor';

/**
 * Вкладка «Профиль» гида — тонкая обёртка над общим PartnerProfileEditor
 * (GET/PATCH /api/partners/profile). Логика вынесена в общий компонент,
 * переиспользуется агентским кабинетом.
 */
export default function GuideProfileForm() {
  return <PartnerProfileEditor namePlaceholder="Иван Камчатский, гид" />;
}
