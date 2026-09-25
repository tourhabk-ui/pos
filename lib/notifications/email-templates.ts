/**
 * Email Templates - HTML шаблоны для email уведомлений
 */

const BRAND_COLOR = '#D4AF37'; // premium-gold
const DARK_BG = '#0A0A0A'; // premium-black

/**
 * Базовый layout для всех писем
 */
function emailLayout(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KamHub - Туристическая платформа Камчатки</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, ${DARK_BG} 0%, #1a1a1a 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: ${BRAND_COLOR}; font-size: 32px; font-weight: 900;">
                  KamHub
              </h1>
              <p style="margin: 8px 0 0; color: rgba(255,255,255,0.7); font-size: 14px;">
                Туристическая платформа Камчатки
              </p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              ${content}
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9f9f9; padding: 30px; text-align: center; border-top: 1px solid #e0e0e0;">
              <p style="margin: 0 0 10px; color: #666; font-size: 14px;">
                С уважением, команда KamHub
              </p>
              <p style="margin: 0; color: #999; font-size: 12px;">
                © 2025 KamHub. Все права защищены.
              </p>
              <p style="margin: 10px 0 0; font-size: 12px;">
                <a href="https://vedarai.ru" style="color: ${BRAND_COLOR}; text-decoration: none;">vedarai.ru</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * 1. Подтверждение бронирования тура
 */
export function bookingConfirmationEmail(data: {
  userName: string;
  tourName: string;
  date: Date;
  guests: number;
  totalPrice: number;
  bookingId: string;
}): { subject: string; html: string } {
  const content = `
    <h2 style="margin: 0 0 20px; color: #333; font-size: 24px;">
      Бронирование подтверждено!  
    </h2>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.userName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Ваше бронирование успешно подтверждено. Мы ждём вас!
    </p>
    
    <div style="background-color: #f9f9f9; border-left: 4px solid ${BRAND_COLOR}; padding: 20px; margin: 20px 0; border-radius: 8px;">
      <h3 style="margin: 0 0 15px; color: #333; font-size: 18px;">Детали бронирования:</h3>
      <p style="margin: 8px 0; color: #666;">
        <strong>Тур:</strong> ${data.tourName}
      </p>
      <p style="margin: 8px 0; color: #666;">
        <strong>Дата:</strong> ${data.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
      <p style="margin: 8px 0; color: #666;">
        <strong>Количество гостей:</strong> ${data.guests}
      </p>
      <p style="margin: 8px 0; color: ${BRAND_COLOR}; font-size: 20px; font-weight: bold;">
        <strong>Сумма:</strong> ${data.totalPrice.toLocaleString('ru-RU')} ₽
      </p>
      <p style="margin: 8px 0; color: #999; font-size: 14px;">
        Номер брони: #${data.bookingId.substring(0, 8)}
      </p>
    </div>
    
    <p style="margin: 20px 0; color: #666; font-size: 16px; line-height: 1.6;">
      За 24 часа до начала тура мы отправим вам напоминание с деталями встречи.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://vedarai.ru/bookings/${data.bookingId}" 
         style="display: inline-block; background-color: ${BRAND_COLOR}; color: #000; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
        Просмотреть бронирование
      </a>
    </div>
  `;

  return {
    subject: `Бронирование подтверждено: ${data.tourName}`,
    html: emailLayout(content)
  };
}

/**
 * 2. Подтверждение оплаты
 */
export function paymentConfirmationEmail(data: {
  userName: string;
  amount: number;
  transactionId: string;
  bookingType: string;
  bookingName: string;
}): { subject: string; html: string } {
  const content = `
    <div style="text-align: center; margin-bottom: 30px;">
      <div style="font-size: 64px; margin-bottom: 20px;">[✓]</div>
      <h2 style="margin: 0; color: #22c55e; font-size: 28px;">
        Оплата прошла успешно!
      </h2>
    </div>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.userName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Мы получили ваш платёж. Спасибо!
    </p>
    
    <div style="background-color: #f0fdf4; border: 2px solid #22c55e; padding: 20px; margin: 20px 0; border-radius: 12px; text-align: center;">
      <p style="margin: 0 0 10px; color: #666; font-size: 14px;">Сумма платежа:</p>
      <p style="margin: 0; color: ${BRAND_COLOR}; font-size: 32px; font-weight: bold;">
        ${data.amount.toLocaleString('ru-RU')} ₽
      </p>
      <p style="margin: 10px 0 0; color: #999; font-size: 12px;">
        ID транзакции: ${data.transactionId}
      </p>
    </div>
    
    <p style="margin: 20px 0; color: #666; font-size: 16px; line-height: 1.6;">
      <strong>Оплачено:</strong> ${data.bookingName}
    </p>
  `;

  return {
    subject: 'Оплата получена - KamHub',
    html: emailLayout(content)
  };
}

/**
 * 3. Напоминание о туре (за 24 часа)
 */
export function tourReminderEmail(data: {
  userName: string;
  tourName: string;
  date: Date;
  time?: string;
  meetingPoint: string;
  guidePhone?: string;
}): { subject: string; html: string } {
  const content = `
    <h2 style="margin: 0 0 20px; color: #333; font-size: 24px;">
      Напоминание о туре завтра!  
    </h2>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.userName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Напоминаем, что завтра вы отправляетесь в тур!
    </p>
    
    <div style="background: linear-gradient(135deg, ${DARK_BG} 0%, #1a1a1a 100%); padding: 30px; margin: 20px 0; border-radius: 12px; color: white;">
      <h3 style="margin: 0 0 20px; color: ${BRAND_COLOR}; font-size: 22px;">
        ${data.tourName}
      </h3>
      <p style="margin: 10px 0; font-size: 16px;">
        <strong style="color: ${BRAND_COLOR};">  Дата:</strong> ${data.date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
      ${data.time ? `
        <p style="margin: 10px 0; font-size: 16px;">
          <strong style="color: ${BRAND_COLOR};">⏰ Время:</strong> ${data.time}
        </p>
      ` : ''}
      <p style="margin: 10px 0; font-size: 16px;">
        <strong style="color: ${BRAND_COLOR};">📍 Место встречи:</strong> ${data.meetingPoint}
      </p>
      ${data.guidePhone ? `
        <p style="margin: 10px 0; font-size: 16px;">
          <strong style="color: ${BRAND_COLOR};">  Телефон гида:</strong> ${data.guidePhone}
        </p>
      ` : ''}
    </div>
    
    <p style="margin: 20px 0; color: #666; font-size: 16px; line-height: 1.6;">
      <strong>Рекомендации:</strong>
    </p>
    <ul style="color: #666; font-size: 15px; line-height: 1.8;">
      <li>Приходите за 15 минут до начала</li>
      <li>Возьмите удобную обувь</li>
      <li>Проверьте прогноз погоды</li>
      <li>Не забудьте документы</li>
    </ul>
  `;

  return {
    subject: `Напоминание: ${data.tourName} завтра!`,
    html: emailLayout(content)
  };
}

/**
 * 4. Отмена бронирования
 */
export function bookingCancellationEmail(data: {
  userName: string;
  tourName: string;
  date: Date;
  bookingId: string;
  refundAmount?: number;
}): { subject: string; html: string } {
  const content = `
    <h2 style="margin: 0 0 20px; color: #333; font-size: 24px;">
      Бронирование отменено
    </h2>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.userName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Ваше бронирование было отменено.
    </p>
    
    <div style="background-color: #fee; border-left: 4px solid #f44; padding: 20px; margin: 20px 0; border-radius: 8px;">
      <p style="margin: 8px 0; color: #666;">
        <strong>Тур:</strong> ${data.tourName}
      </p>
      <p style="margin: 8px 0; color: #666;">
        <strong>Дата:</strong> ${data.date.toLocaleDateString('ru-RU')}
      </p>
      <p style="margin: 8px 0; color: #999; font-size: 14px;">
        Номер брони: #${data.bookingId.substring(0, 8)}
      </p>
    </div>
    
    ${data.refundAmount ? `
      <div style="background-color: #f0fdf4; border: 2px solid #22c55e; padding: 20px; margin: 20px 0; border-radius: 12px;">
        <p style="margin: 0; color: #22c55e; font-size: 18px; font-weight: bold;">
          Возврат средств: ${data.refundAmount.toLocaleString('ru-RU')} ₽
        </p>
        <p style="margin: 10px 0 0; color: #666; font-size: 14px;">
          Средства поступят на вашу карту в течение 5-10 рабочих дней
        </p>
      </div>
    ` : ''}
    
    <p style="margin: 20px 0; color: #666; font-size: 16px; line-height: 1.6;">
      Будем рады видеть вас снова на Камчатке!
    </p>
  `;

  return {
    subject: `Бронирование отменено: ${data.tourName}`,
    html: emailLayout(content)
  };
}

/**
 * 5. Приветственное письмо (регистрация)
 */
export function welcomeEmail(data: {
  userName: string;
  userEmail: string;
}): { subject: string; html: string } {
  const content = `
    <div style="text-align: center; margin-bottom: 30px;">
      <div style="font-size: 64px; margin-bottom: 20px;"> </div>
      <h2 style="margin: 0; color: #333; font-size: 28px;">
        Добро пожаловать на Камчатку!
      </h2>
    </div>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.userName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Спасибо за регистрацию на KamHub - туристической платформе Камчатки!
    </p>
    
    <div style="background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); padding: 30px; margin: 30px 0; border-radius: 12px;">
      <h3 style="margin: 0 0 15px; color: #333; font-size: 20px;">Что вы можете делать:</h3>
      <ul style="margin: 0; padding-left: 20px; color: #666; font-size: 15px; line-height: 1.8;">
        <li>Бронировать туры и экскурсии</li>
        <li>Искать трансферы и размещение</li>
        <li>Планировать маршруты с AI-ассистентом</li>
        <li>Копить бонусы за каждое бронирование</li>
        <li>Оставлять отзывы о турах</li>
      </ul>
    </div>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://vedarai.ru/hub/tourist" 
         style="display: inline-block; background-color: ${BRAND_COLOR}; color: #000; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
        Перейти в личный кабинет
      </a>
    </div>
    
    <p style="margin: 20px 0; color: #666; font-size: 14px; line-height: 1.6;">
      Если у вас есть вопросы, мы всегда готовы помочь. Просто ответьте на это письмо.
    </p>
  `;

  return {
    subject: 'Добро пожаловать на KamHub!  ',
    html: emailLayout(content)
  };
}

/**
 * 6. Восстановление пароля
 */
export function passwordResetEmail(data: {
  userName: string;
  resetLink: string;
}): { subject: string; html: string } {
  const content = `
    <h2 style="margin: 0 0 20px; color: #333; font-size: 24px;">
      Восстановление пароля  
    </h2>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.userName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Вы запросили восстановление пароля для вашего аккаунта на KamHub.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${data.resetLink}" 
         style="display: inline-block; background-color: ${BRAND_COLOR}; color: #000; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
        Сбросить пароль
      </a>
    </div>
    
    <p style="margin: 20px 0; color: #999; font-size: 14px; line-height: 1.6; text-align: center;">
      Ссылка действительна в течение 1 часа
    </p>
    
    <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 8px;">
      <p style="margin: 0; color: #856404; font-size: 14px;">
        ! Если вы не запрашивали восстановление пароля, просто проигнорируйте это письмо.
      </p>
    </div>
  `;

  return {
    subject: 'Восстановление пароля - KamHub',
    html: emailLayout(content)
  };
}

/**
 * 7. Верификация партнёра
 */
export function partnerVerificationEmail(data: {
  partnerName: string;
  category: string;
}): { subject: string; html: string } {
  const content = `
    <div style="text-align: center; margin-bottom: 30px;">
      <div style="font-size: 64px; margin-bottom: 20px;">[✓]</div>
      <h2 style="margin: 0; color: #22c55e; font-size: 28px;">
        Вы верифицированы!
      </h2>
    </div>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Здравствуйте, ${data.partnerName}!
    </p>
    
    <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
      Поздравляем! Ваш аккаунт успешно верифицирован на платформе KamHub.
    </p>
    
    <div style="background-color: #f0fdf4; border-left: 4px solid #22c55e; padding: 20px; margin: 20px 0; border-radius: 8px;">
      <p style="margin: 8px 0; color: #666;">
        <strong>Компания:</strong> ${data.partnerName}
      </p>
      <p style="margin: 8px 0; color: #666;">
        <strong>Категория:</strong> ${data.category}
      </p>
      <p style="margin: 15px 0 0; color: #22c55e; font-size: 18px; font-weight: bold;">
        [✓] Статус: Верифицирован
      </p>
    </div>
    
    <p style="margin: 20px 0; color: #666; font-size: 16px; line-height: 1.6;">
      Теперь ваши предложения отображаются с меткой "Верифицировано", что повышает доверие клиентов.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://vedarai.ru/hub/operator" 
         style="display: inline-block; background-color: ${BRAND_COLOR}; color: #000; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
        Перейти в панель управления
      </a>
    </div>
  `;

  return {
    subject: 'Ваш аккаунт верифицирован - KamHub',
    html: emailLayout(content)
  };
}

// Экспорт всех шаблонов
export const emailTemplates = {
  bookingConfirmation: bookingConfirmationEmail,
  paymentConfirmation: paymentConfirmationEmail,
  tourReminder: tourReminderEmail,
  bookingCancellation: bookingCancellationEmail,
  welcome: welcomeEmail,
  passwordReset: passwordResetEmail,
  partnerVerification: partnerVerificationEmail
};



