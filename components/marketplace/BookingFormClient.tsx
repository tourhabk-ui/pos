'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Users, Phone, Mail, User, ChevronRight } from 'lucide-react';
import TourDateField from '@/components/marketplace/TourDateField';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { funnelBeacon } from '@/lib/funnel/beacon';

interface BookingFormProps {
  tourId: number;
  basePrice: number;
  maxParticipants?: number;
  tourTitle?: string;
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + ' ₽';
}

export default function BookingFormClient({ tourId, basePrice, maxParticipants = 10, tourTitle }: BookingFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Предвыбор даты из ?date= (день плана, «Мой план 2.0» B-3): клик
  // «забронировать» из дня плана не должен заставлять вводить дату, которую
  // план уже знает. Читаем на клиенте через window.location — серверный
  // searchParams выбил бы карточку тура из ISR-кэша. Мусор отбрасывается,
  // уже введённую руками дату не перетираем.
  useEffect(() => {
    try {
      const d = new URLSearchParams(window.location.search).get('date');
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        setFormData(prev => (prev.booking_date ? prev : { ...prev, booking_date: d }));
      }
    } catch { /* предвыбор необязателен */ }
  }, []);

  // Маяк воронки: первое касание формы — событие booking_start, один раз за
  // жизнь компонента (сервер дополнительно дедупит час на посетителя).
  const [funnelStarted, setFunnelStarted] = useState(false);
  const markFunnelStart = () => {
    if (funnelStarted) return;
    setFunnelStarted(true);
    funnelBeacon('booking_start', String(tourId));
  };
  const [formData, setFormData] = useState({
    tourist_name: '',
    tourist_email: '',
    tourist_phone: '',
    participants_count: '1',
    booking_date: '',
    special_requests: '',
  });
  /**
   * Согласие на обработку ПД. Заведено 14.09: замер показал, что
   * PdConsentCheckbox стоит на ДЕВЯТИ поверхностях платформы и не стоит ровно
   * на этой — при том, что здесь собирают имя, телефон и почту гостя. Гостевая
   * бронь — единственный путь, которым платформа берёт ПД человека без
   * аккаунта, и права на это у неё не было записано нигде.
   */
  const [pdConsent, setPdConsent] = useState(false);

  const participants = parseInt(formData.participants_count) || 1;
  const totalPrice = basePrice * participants;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.booking_date) {
      setError('Выберите дату заезда');
      return;
    }
    // Согласие проверяется и здесь, а не только выключенной кнопкой: гейт,
    // держащийся одним `disabled`, переживает ровно до первой правки вёрстки.
    if (!pdConsent) {
      setError('Нужно согласие на обработку данных, чтобы мы могли связаться с вами');
      return;
    }
    /**
     * Телефон приводится к единому виду ПЕРЕД отправкой — иначе оператор
     * получает «8 900...», «+7(900)...» и «9001234567» как три разных номера,
     * а сервер их не различает: там `min(10)` по длине строки.
     *
     * Хелпер существующий (lib/mcp/normalize-phone): мягкая проверка, не
     * строго-РФ — турист бывает иностранным, — и мусор даёт null, а не
     * выдуманный номер. Четвёртую нормализацию заводить нельзя: в репозитории
     * их уже три, и одна из них обслуживает телефоны спасения.
     */
    const phone = normalizePhone(formData.tourist_phone);
    if (!phone) {
      setError('Проверьте телефон: нужен номер из 10–15 цифр, например +7 900 000 00 00');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/hub/bookings/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // id тура приходит из базы строкой (bigint); сервер тоже приводит,
          // но форма обязана слать число сама (issue #1769).
          tour_id: Number(tourId),
          ...formData,
          tourist_phone: phone,
          participants_count: participants,
          // СОСТОЯНИЕ галочки, а не литерал `true`. Девять соседних форм шлют
          // литерал, и это работает лишь пока кнопка выключена: снимут
          // `disabled` — согласие уедет без галочки, а сервер не отличит,
          // потому что проверяет, ЧТО пришло, а не что человек нажимал.
          pd_consent: pdConsent,
        }),
      });

      const data: unknown = await res.json();
      if (!res.ok) {
        const raw = typeof data === 'object' && data !== null && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : '';
        // Туристу — только русский текст. Служебные сообщения валидатора
        // (английские) заменяем на понятное, а причину оставляем консоли.
        const msg = /[А-Яа-яЁё]/.test(raw) ? raw : 'Не удалось отправить заявку. Проверьте поля и попробуйте ещё раз.';
        if (!/[А-Яа-яЁё]/.test(raw)) console.error('[BookingForm] отказ сервера', res.status, raw);
        throw new Error(msg);
      }

      const id = typeof data === 'object' && data !== null && 'booking_id' in data
        ? (data as Record<string, unknown>).booking_id
        : null;
      if (!id) throw new Error('Бронирование создано, но ID не получен. Проверьте раздел «Бронирования».');
      // Ключ брони приходит один раз и живёт только в этой ссылке: номер
      // брони подтверждения больше не открывает (миграция 943).
      const token = typeof data === 'object' && data !== null && 'access_token' in data
        ? String((data as Record<string, unknown>).access_token)
        : '';
      router.push(`/booking-success/${id}?t=${encodeURIComponent(token)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  const maxOpts = Math.min(maxParticipants, 12);

  return (
    <form onSubmit={handleSubmit} onFocusCapture={markFunnelStart} className="ds-card p-6 space-y-5">
      <div>
        <h2 className="ds-h2 mb-0.5">Оставить заявку на тур</h2>
        {tourTitle && <p className="text-sm text-[var(--text-secondary)]">{tourTitle}</p>}
        <p className="text-xs text-[var(--text-muted)] mt-2">
          Сначала фиксируем заявку и детали поездки. Финальные условия участия подтверждаются перед оплатой.
        </p>
      </div>

      {/* Дата — первое поле */}
      <div>
        <label className="ds-label flex items-center gap-1.5 mb-1.5">
          <Calendar className="w-3.5 h-3.5" />
          Дата заезда *
        </label>
        <TourDateField
          tourId={tourId}
          tourTitle={tourTitle}
          value={formData.booking_date}
          onChange={(date) => setFormData(prev => ({ ...prev, booking_date: date }))}
        />
      </div>

      {/* Участники */}
      <div>
        <label className="ds-label flex items-center gap-1.5 mb-1.5">
          <Users className="w-3.5 h-3.5" />
          Количество участников *
        </label>
        <select
          name="participants_count"
          value={formData.participants_count}
          onChange={handleChange}
          className="ds-input w-full"
        >
          {Array.from({ length: maxOpts }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n} {n === 1 ? 'человек' : n < 5 ? 'человека' : 'человек'}</option>
          ))}
        </select>
      </div>

      {/* Контакты */}
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="ds-label flex items-center gap-1.5 mb-1.5">
            <User className="w-3.5 h-3.5" />
            Имя *
          </label>
          <input
            type="text"
            name="tourist_name"
            value={formData.tourist_name}
            onChange={handleChange}
            placeholder="Иван Иванов"
            className="ds-input w-full"
            required
          />
        </div>
        <div>
          <label className="ds-label flex items-center gap-1.5 mb-1.5">
            <Phone className="w-3.5 h-3.5" />
            Телефон *
          </label>
          <input
            type="tel"
            name="tourist_phone"
            value={formData.tourist_phone}
            onChange={handleChange}
            placeholder="+7 900 000 00 00"
            className="ds-input w-full"
            required
          />
        </div>
        <div>
          <label className="ds-label flex items-center gap-1.5 mb-1.5">
            <Mail className="w-3.5 h-3.5" />
            Email *
          </label>
          <input
            type="email"
            name="tourist_email"
            value={formData.tourist_email}
            onChange={handleChange}
            placeholder="ivan@example.com"
            className="ds-input w-full"
            required
          />
        </div>
      </div>

      <div>
        <label className="ds-label mb-1.5">Пожелания оператору</label>
        <textarea
          name="special_requests"
          value={formData.special_requests}
          onChange={handleChange}
          className="ds-input w-full resize-none"
          rows={3}
          placeholder="Особые пожелания, вопросы по снаряжению..."
        />
      </div>

      {error && (
        <div className="bg-[var(--danger)] bg-opacity-10 border border-[var(--danger)] text-[var(--danger)] p-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <p className="text-xs text-[var(--text-muted)]">
        Отправляя заявку, вы понимаете, что даты, наличие мест и точная стоимость уточняются перед оплатой.
      </p>

      <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="pd-consent-tour-booking" />

      {/* Итог */}
      <div className="border-t border-[var(--border)] pt-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm text-[var(--text-muted)]">
              {formatPrice(basePrice)} × {participants} чел.
            </p>
            <p className="text-2xl font-bold text-[var(--text-primary)]">
              {formatPrice(totalPrice)}
            </p>
          </div>
          {/* Без даты кнопка выключена — и обязана ВЫГЛЯДЕТЬ выключенной и
              говорить почему: прогулка 10.09 нашла её оранжевой и молчащей
              (issue #1780), человек жал и не понимал, что не так. */}
          <button
            type="submit"
            disabled={loading || !formData.booking_date || !pdConsent}
            aria-describedby={!formData.booking_date || !pdConsent ? 'booking-submit-hint' : undefined}
            className="ds-btn ds-btn-primary flex items-center gap-2 px-6 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          >
            {loading ? (
              <span className="animate-spin rounded-full h-4 w-4 border border-white border-t-transparent" />
            ) : (
              <>
                Оставить заявку
                <ChevronRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
        {/* Причина, по которой кнопка выключена, называется КОНКРЕТНАЯ. Одно
            «заполните форму» на два разных препятствия заставляет искать
            глазами, чего не хватает (урок #1780). */}
        {!formData.booking_date ? (
          <p id="booking-submit-hint" className="text-xs text-[var(--warning)]">
            Сначала выберите дату заезда в календаре выше.
          </p>
        ) : !pdConsent ? (
          <p id="booking-submit-hint" className="text-xs text-[var(--warning)]">
            Отметьте согласие на обработку данных — без него мы не сможем связаться с вами.
          </p>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            После создания заявки откроется страница бронирования с дальнейшими шагами. Оператор получит уведомление автоматически.
            {/* Про повтор говорим ЧЕСТНО: идемпотентности у создания брони нет
                (ни ключа, ни ON CONFLICT — проверено 14.09), и обещание
                «заявка не продублируется» было бы прямым враньём. Ограничение
                частоты 5/мин повтор не отменяет. */}
            {' '}Если отправка не удалась — подождите минуту и попробуйте снова, а не нажимайте несколько раз подряд.
          </p>
        )}
      </div>
    </form>
  );
}
