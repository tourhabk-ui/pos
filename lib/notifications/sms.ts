// =============================================
// СЕРВИС SMS УВЕДОМЛЕНИЙ
// Kamchatour Hub - SMS Notification Service
// =============================================

import { logSwallowedFailure } from '@/lib/observability/swallowed';

interface SMSMessage {
  to: string;
  text: string;
  sender?: string;
}

interface SMSResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class SMSNotificationService {
  private apiKey: string;
  private baseUrl: string = 'https://sms.ru/sms/send';

  constructor() {
    this.apiKey = process.env.SMS_RU_API_KEY || '';
    if (!this.apiKey) {
      // Пустое тело этого `if` стояло здесь с заведения файла: автор увидел
      // состояние «ключа нет», завёл под него ветку и не сказал о нём ничего.
      // Сервис молча превращался в заглушку, а «SMS не пришла» выглядело как
      // сбой оператора связи, а не как незаданная переменная (§4.0: отказ не
      // глушится, имя проверки — в лог). Печатается ИМЯ переменной, никогда
      // значение.
      logSwallowedFailure(
        'sms',
        'SMSNotificationService.constructor',
        new Error('SMS_RU_API_KEY не задан — SMS-уведомления отправляться не будут'),
      );
    }
  }

  // Отправка SMS
  async sendSMS(message: SMSMessage): Promise<SMSResponse> {
    if (!this.apiKey) {
      return {
        success: false,
        error: 'SMS service not configured'
      };
    }

    try {
      const formData = new URLSearchParams({
        api_id: this.apiKey,
        to: message.to,
        msg: message.text,
        from: message.sender || 'Kamchatour',
        json: '1'
      });

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData
      });

      const data = await response.json();

      if (data.status === 'OK') {
        return {
          success: true,
          messageId: data.sms[message.to]?.sms_id
        };
      } else {
        return {
          success: false,
          error: data.status_text || 'Unknown error'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Уведомление о новой заявке на трансфер
  async sendBookingRequest(phone: string, bookingDetails: {
    route: string;
    date: string;
    time: string;
    passengers: number;
    price: number;
  }): Promise<SMSResponse> {
    const text = `  Новая заявка на трансфер\n` +
      `Маршрут: ${bookingDetails.route}\n` +
      `Дата: ${bookingDetails.date}\n` +
      `Время: ${bookingDetails.time}\n` +
      `Пассажиры: ${bookingDetails.passengers}\n` +
      `Цена: ${bookingDetails.price} ₽\n\n` +
      `Подтвердите в течение 15 минут`;

    return this.sendSMS({
      to: phone,
      text,
      sender: 'Kamchatour'
    });
  }

  // Подтверждение бронирования
  async sendBookingConfirmation(phone: string, confirmationDetails: {
    confirmationCode: string;
    route: string;
    date: string;
    time: string;
    driverName: string;
    driverPhone: string;
  }): Promise<SMSResponse> {
    const text = `[✓] Бронирование подтверждено\n` +
      `Код: ${confirmationDetails.confirmationCode}\n` +
      `Маршрут: ${confirmationDetails.route}\n` +
      `Дата: ${confirmationDetails.date}\n` +
      `Время: ${confirmationDetails.time}\n` +
      `Водитель: ${confirmationDetails.driverName}\n` +
      `Телефон: ${confirmationDetails.driverPhone}`;

    return this.sendSMS({
      to: phone,
      text,
      sender: 'Kamchatour'
    });
  }

  // Напоминание о поездке
  async sendTripReminder(phone: string, tripDetails: {
    route: string;
    departureTime: string;
    meetingPoint: string;
    driverName: string;
    driverPhone: string;
  }): Promise<SMSResponse> {
    const text = `⏰ Напоминание о поездке\n` +
      `Маршрут: ${tripDetails.route}\n` +
      `Время отправления: ${tripDetails.departureTime}\n` +
      `Место встречи: ${tripDetails.meetingPoint}\n` +
      `Водитель: ${tripDetails.driverName}\n` +
      `Телефон: ${tripDetails.driverPhone}`;

    return this.sendSMS({
      to: phone,
      text,
      sender: 'Kamchatour'
    });
  }

  // Отмена поездки
  async sendTripCancellation(phone: string, cancellationDetails: {
    route: string;
    date: string;
    reason: string;
    refundAmount?: number;
  }): Promise<SMSResponse> {
    let text = `[✗] Поездка отменена\n` +
      `Маршрут: ${cancellationDetails.route}\n` +
      `Дата: ${cancellationDetails.date}\n` +
      `Причина: ${cancellationDetails.reason}`;

    if (cancellationDetails.refundAmount) {
      text += `\nВозврат: ${cancellationDetails.refundAmount} ₽`;
    }

    return this.sendSMS({
      to: phone,
      text,
      sender: 'Kamchatour'
    });
  }

  // Уведомление водителю о новой заявке
  async sendDriverNotification(phone: string, bookingDetails: {
    route: string;
    date: string;
    time: string;
    passengers: number;
    price: number;
    bookingId: string;
  }): Promise<SMSResponse> {
    const text = `  Новая заявка для водителя\n` +
      `Маршрут: ${bookingDetails.route}\n` +
      `Дата: ${bookingDetails.date}\n` +
      `Время: ${bookingDetails.time}\n` +
      `Пассажиры: ${bookingDetails.passengers}\n` +
      `Цена: ${bookingDetails.price} ₽\n` +
      `ID заявки: ${bookingDetails.bookingId}\n\n` +
      `Подтвердите в приложении`;

    return this.sendSMS({
      to: phone,
      text,
      sender: 'Kamchatour'
    });
  }

  // Статистика для оператора
  async sendOperatorStats(phone: string, stats: {
    date: string;
    totalBookings: number;
    totalRevenue: number;
    completedTrips: number;
  }): Promise<SMSResponse> {
    const text = `  Статистика за ${stats.date}\n` +
      `Заявок: ${stats.totalBookings}\n` +
      `Выполнено: ${stats.completedTrips}\n` +
      `Доход: ${stats.totalRevenue} ₽`;

    return this.sendSMS({
      to: phone,
      text,
      sender: 'Kamchatour'
    });
  }

  // Проверка статуса SMS
  async checkSMSStatus(messageId: string): Promise<{
    success: boolean;
    status?: string;
    error?: string;
  }> {
    if (!this.apiKey) {
      return {
        success: false,
        error: 'SMS service not configured'
      };
    }

    try {
      // encodeURIComponent на обоих: ключ приходит из окружения, messageId —
      // из ответа провайдера, и ни один из них не обязан быть безопасным в
      // составе URL. Незакодированный `&` или `#` в значении молча обрезает
      // строку запроса, и вопрос уходит не тот, что собирались задать.
      const url = new URL('https://sms.ru/sms/status');
      url.searchParams.set('api_id', this.apiKey);
      url.searchParams.set('sms_id', messageId);
      url.searchParams.set('json', '1');
      const response = await fetch(url);
      const data = await response.json();

      return {
        success: true,
        status: data.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // Получение баланса
  async getBalance(): Promise<{
    success: boolean;
    balance?: number;
    error?: string;
  }> {
    if (!this.apiKey) {
      return {
        success: false,
        error: 'SMS service not configured'
      };
    }

    try {
      const url = new URL('https://sms.ru/my/balance');
      url.searchParams.set('api_id', this.apiKey);
      url.searchParams.set('json', '1');
      const response = await fetch(url);
      const data = await response.json();

      return {
        success: true,
        balance: data.balance
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Создаем глобальный экземпляр
export const smsService = new SMSNotificationService();

// Экспортируем типы
export type { SMSMessage, SMSResponse };