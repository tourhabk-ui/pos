/**
 * Service barrel file — re-exports all domain services.
 * Provides backward compatibility: `import { tourService } from '@/lib/services'` still works.
 */

// Error classes
export {
  TourNotFoundError,
  TourValidationError,
  TourAlreadyPublishedError,
  ReviewNotFoundError,
  ReviewValidationError,
  DuplicateReviewError,
} from './_errors';

// Tour / Review / Search
export { tourService } from './tours/tour.service';
export { reviewService } from './operators/review.service';
export { searchService } from './search.service';

// Booking / Availability
export { bookingService, availabilityService } from './tours/booking.service';

// Partner (operators)
export { partnerService } from './operators/partner.service';

// Payment / Commission / Payout
export { commissionService, payoutService } from './payment.service';

// RAG / Knowledge Base
export { knowledgeBaseService } from './rag.service';

// Chat (conversation-based user-to-user messaging)
export { chatService } from './operators/chat.service';

// Notifications
export { notificationService } from './operators/notification.service';

// Support (agents, feedback, SLA, ticket messages)
// ticketMessageService снят 04.09: писал в ticket_messages, которую никто
// не читал; переписка тикета живёт в support_tickets.messages (lib/support).
export { agentService, feedbackService, slaService } from './operators/support.service';

// Analytics (dashboard, metrics, reports)
export { dashboardService, metricsService, reportService } from './analytics.service';

// «Pillar»-сервисы сняты 04.09: каталог pillars/ держал три файла и 47
// алиасов в tsconfig, из которых не использовался ни один. paymentService и
// wishlistService никто не звал, их таблицы не объявлены ни одной миграцией;
// ticketService INSERT-ил колонки, которых у support_tickets нет. Сторожа
// схемы этого не видели только потому, что pillars/ не сканировался.
// Тикеты поддержки — единственный сервис lib/support/ticket.service.
