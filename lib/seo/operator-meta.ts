/**
 * Описание страницы оператора для поиска (meta description, og:description).
 *
 * Аудит SEO 29.09 (Н14): у /operators/kamchatka-rafting description не было
 * вовсе. Цепочка `short_description ?? description ?? заглушка` пропускала
 * ПУСТУЮ строку — `??` подставляет запас только для null, — и заглушка не
 * доходила. Сама заглушка к тому же называла оператора «проверенным»
 * независимо от is_verified: обещание, которого данные не давали (§4.0).
 *
 * Правило: первое непустое из short_description и description, обрезанное
 * по предложению или слову (metaDescription); оба пусты — нейтральная строка
 * с именем, без оценок.
 */
import { metaDescription } from './meta-description';

export interface OperatorMetaInput {
  name: string;
  short_description?: string | null;
  description?: string | null;
}

export function operatorMetaDescription(p: OperatorMetaInput): string {
  for (const text of [p.short_description, p.description]) {
    const d = metaDescription(text);
    if (d) return d;
  }
  return `${p.name} — туроператор Камчатки. Профиль и контакты на Ведаре.`;
}
