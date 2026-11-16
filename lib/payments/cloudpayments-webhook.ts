/**
 * CLOUDPAYMENTS WEBHOOK VALIDATION
 * Проверка подлинности webhook запросов от CloudPayments
 * 
 * Защита от:
 * - Поддельных webhook запросов
 * - Replay attacks
 * - Man-in-the-middle атак
 * 
 * @author Cursor AI Agent
 * @date 2025-10-30
 */

import crypto from 'crypto';
import { parseCloudPaymentsBody } from '@/lib/payments/cloudpayments-body';

/**
 * CloudPayments Webhook Data Interface
 */
export interface CloudPaymentsWebhook {
  TransactionId: number;
  Amount: number;
  Currency: string;
  PaymentAmount: number;
  PaymentCurrency: string;
  InvoiceId: string;      // booking ID
  AccountId: string;      // user ID
  Email: string;
  DateTime: string;
  TestMode: boolean;
  Status: 'Completed' | 'Declined' | 'Pending' | 'Cancelled';
  StatusCode?: number;
  Reason?: string;
  ReasonCode?: number;
  CardFirstSix?: string;
  CardLastFour?: string;
  CardType?: string;
  CardExpDate?: string;
  IpAddress?: string;
  IpCountry?: string;
  Description?: string;
  Data?: Record<string, unknown>;
}

/**
 * Валидация HMAC подписи CloudPayments
 * 
 * CloudPayments отправляет подпись в header X-Content-HMAC
 * Подпись вычисляется: HMAC-SHA256(request_body, API_SECRET)
 */
export function validateCloudPaymentsSignature(
  requestBody: string | Buffer,
  signature: string | null,
  apiSecret: string
): boolean {
  if (!signature) {
    return false;
  }
  
  if (!apiSecret) {
    return false;
  }
  
  try {
    // Вычисляем HMAC из request body
    const body = typeof requestBody === 'string' 
      ? requestBody 
      : requestBody.toString('utf8');
    
    const computed = crypto
      .createHmac('sha256', apiSecret)
      .update(body)
      .digest('base64');
    
    // Сравниваем с полученной подписью (timing-safe)
    const computedBuffer = Buffer.from(computed);
    const signatureBuffer = Buffer.from(signature);
    
    if (computedBuffer.length !== signatureBuffer.length) {
      return false;
    }
    
    const isValid = crypto.timingSafeEqual(computedBuffer, signatureBuffer);
    
    if (!isValid) {
    }
    
    return isValid;
    
  } catch (error) {
    return false;
  }
}

/**
 * Валидация данных webhook
 */
export function validateWebhookData(data: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Invalid webhook data: expected object'] };
  }

  const d = data as Record<string, unknown>;

  // Обязательные поля
  const requiredFields = ['TransactionId', 'Amount', 'Currency', 'InvoiceId', 'Status'];
  for (const field of requiredFields) {
    if (!d[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (d.TransactionId && typeof d.TransactionId !== 'number') {
    errors.push('TransactionId must be a number');
  }

  if (d.Amount && typeof d.Amount !== 'number') {
    errors.push('Amount must be a number');
  }

  if (d.Amount && typeof d.Amount === 'number' && d.Amount <= 0) {
    errors.push('Amount must be positive');
  }

  const validStatuses = ['Completed', 'Declined', 'Pending', 'Cancelled'];
  if (d.Status && !validStatuses.includes(d.Status as string)) {
    errors.push(`Invalid status: ${d.Status}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Обработка CloudPayments webhook с полной валидацией
 */
export async function processCloudPaymentsWebhook(
  requestBody: string | Buffer,
  signature: string | null
): Promise<{
  success: boolean;
  error?: string;
  errorCode?: string;
  data?: CloudPaymentsWebhook;
}> {
  // 1. Валидация подписи
  const apiSecret = process.env.CLOUDPAYMENTS_API_SECRET;
  
  if (!apiSecret) {
    return {
      success: false,
      error: 'CloudPayments API secret not configured',
      errorCode: 'CONFIG_ERROR'
    };
  }
  
  const signatureValid = validateCloudPaymentsSignature(
    requestBody,
    signature,
    apiSecret
  );
  
  if (!signatureValid) {
    return {
      success: false,
      error: 'Invalid webhook signature',
      errorCode: 'INVALID_SIGNATURE'
    };
  }
  
  // 2. Разбор: форма или JSON — как выбрано в кабинете (#3433 п. 2). Раньше
  // только JSON: при форме каждая оплата отвечала 400 и не записывалась.
  const parsed = parseCloudPaymentsBody(
    typeof requestBody === 'string' ? requestBody : requestBody.toString('utf8'),
  );
  if (!parsed) {
    return {
      success: false,
      error: 'Webhook body is neither JSON nor form',
      errorCode: 'INVALID_BODY'
    };
  }
  const webhookData = parsed as unknown as CloudPaymentsWebhook;
  
  // 3. Валидация данных
  const dataValidation = validateWebhookData(webhookData);
  if (!dataValidation.valid) {
    return {
      success: false,
      error: `Validation failed: ${dataValidation.errors.join(', ')}`,
      errorCode: 'VALIDATION_ERROR'
    };
  }
  
  // Повтор уведомления приёмники узнают сами, под блокировкой брони. Здесь
  // стояла «проверка дубля» по transfer_payments — чужой таблице, с пустым
  // catch и без последствий: результат не читал никто (#3433 п. 2).

  // 4. Все проверки пройдены
  return {
    success: true,
    data: webhookData
  };
}

/**
 * Создание тестового webhook для testing
 * ТОЛЬКО ДЛЯ РАЗРАБОТКИ!
 */
export function createTestWebhook(
  bookingId: string,
  amount: number,
  status: 'Completed' | 'Declined' = 'Completed'
): {
  body: string;
  signature: string;
} {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Test webhooks not allowed in production');
  }
  
  const webhookData: CloudPaymentsWebhook = {
    TransactionId: Math.floor(Math.random() * 1000000),
    Amount: amount,
    Currency: 'RUB',
    PaymentAmount: amount,
    PaymentCurrency: 'RUB',
    InvoiceId: bookingId,
    AccountId: 'test-user',
    Email: 'test@example.com',
    DateTime: new Date().toISOString(),
    TestMode: true,
    Status: status
  };
  
  const body = JSON.stringify(webhookData);
  
  const apiSecret = process.env.CLOUDPAYMENTS_API_SECRET || 'test-secret';
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(body)
    .digest('base64');
  
  return { body, signature };
}

/**
 * ИСПОЛЬЗОВАНИЕ В API ROUTE:
 * 
 * import { processCloudPaymentsWebhook } from '@/lib/payments/cloudpayments-webhook';
 * 
 * export async function POST(request: NextRequest) {
 *   // Получаем raw body (ВАЖНО: не парсить как JSON автоматически!)
 *   const rawBody = await request.text();
 *   
 *   // Получаем подпись из header
 *   const signature = request.headers.get('X-Content-HMAC');
 *   
 *   // Валидация webhook
 *   const validation = await processCloudPaymentsWebhook(rawBody, signature);
 *   
 *   if (!validation.success) {
 *     console.error('Webhook validation failed:', validation.error);
 *     return NextResponse.json({ code: 13 }); // CloudPayments error code
 *   }
 *   
 *   const webhookData = validation.data!;
 *   
 *   // Обработка webhook
 *   if (webhookData.Status === 'Completed') {
 *     await confirmBooking(webhookData.InvoiceId, webhookData.TransactionId);
 *   }
 *   
 *   // CloudPayments ожидает { code: 0 } для success
 *   return NextResponse.json({ code: 0 });
 * }
 * 
 * 
 * ТЕСТИРОВАНИЕ:
 * 
 * import { createTestWebhook } from '@/lib/payments/cloudpayments-webhook';
 * 
 * const { body, signature } = createTestWebhook('booking-123', 1500);
 * 
 * const response = await fetch('/api/transfers/payment/confirm', {
 *   method: 'POST',
 *   headers: {
 *     'Content-Type': 'application/json',
 *     'X-Content-HMAC': signature
 *   },
 *   body: body
 * });
 */
