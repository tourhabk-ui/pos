/**
 * Вопрос и ответ блока «Вопросы и ответы» (слово владельца 17.11 «2 да но
 * аккуратно»). Ответы собирает модуль своей сущности — `lib/tours/tour-faq`,
 * `lib/places/place-faq`; рисует `components/faq/FaqSection`.
 */
export interface FaqItem {
  question: string;
  answer: string;
}
