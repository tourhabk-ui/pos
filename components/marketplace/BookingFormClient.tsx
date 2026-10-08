'use client';

import { GUEST_EMAIL_REQUIRED_MESSAGE } from '@/lib/bookings/guest-contact';
import { useEffect, useRef, useState } from 'react';
import { bookingTotal, normalizePriceUnit } from '@/lib/tours/booking-total';
import { tourDurationDays } from '@/lib/bookings/duration';
import { useRouter } from 'next/navigation';
import { Calendar, Users, Phone, Mail, User, ChevronRight, AlertCircle, Loader2, MessageSquare } from 'lucide-react';
import TourDateField from '@/components/marketplace/TourDateField';
import { SeatRequestForm } from '@/components/planner/SeatRequestForm';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { normalizePhone } from '@/lib/mcp/normalize-phone';
import { funnelBeacon } from '@/lib/funnel/beacon';
import { agentReferralForBooking } from '@/lib/referral/agent-link';
import { cancellationTermsLine, type TourRefundTerms } from '@/lib/payments/tour-refund';
import { platformAcceptsPayments } from '@/lib/payments/accepting';

interface BookingFormProps {
  tourId: number;
  basePrice: number;
  /** operator_tours.price_unit — за что стоит basePrice (lib/tours/booking-total). */
  priceUnit?: string | null;
  /** Длительность — нужна для «за человека в день». */
  duration?: { multi_day_count: number | null; duration_hours: number | null };
  maxParticipants?: number;
  tourTitle?: string;
  /**
   * Дата, уже выбранная снаружи (день в /calendar, «ближайший выезд» на
   * маршруте). Ручной выбор и ?date= она не перетирает — только стартовое
   * значение.
   */
  initialDate?: string | null;
  /**
   * Условия отмены тура (1012). Не переданы — строки нет: форма стоит и там,
   * где тура с условиями под рукой нет (модалка). Переданы с NULL — это
   * «не записаны», и строка честно говорит о полном возврате.
   */
  cancellationTerms?: TourRefundTerms | null;
  /**
   * У тура нет расписания, а у оператора есть мессенджер (решает страница
   * тура, 04.10). Тогда первый путь — спросить места: оператор отвечает
   * кнопкой до 2 часов, «Есть места» сразу заводит подтверждённую бронь и
   * открывает оплату. Раньше карточка давала ввести дату вслепую и заводила
   * обычную заявку, которую оператор видел как бронь на неизвестно чью дату.
   * Обычная заявка остаётся одной кнопкой ниже.
   */
  askSeatsFirst?: boolean;
}

/** Неразрывный пробел перед ₽: «52 000 / ₽» на двух строках — аудит 24.09. */
function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + '\u00a0₽';
}

/** Поля формы, которые умеет назвать ответ сервера (`field` из Zod) или своя проверка. */
type FormField = 'booking_date' | 'participants_count' | 'tourist_name' | 'tourist_phone' | 'tourist_email' | 'special_requests' | 'pd_consent';
const FORM_FIELDS: readonly FormField[] = ['booking_date', 'participants_count', 'tourist_name', 'tourist_phone', 'tourist_email', 'special_requests', 'pd_consent'];
function asFormField(v: unknown): FormField | null {
  return typeof v === 'string' && (FORM_FIELDS as readonly string[]).includes(v) ? (v as FormField) : null;
}

/**
 * Отказ формы. `kind` различает «вы ввели не то» (проверка поля) и «отправка
 * не удалась» (сеть, сервер, лимит частоты): совет подождать и повторить
 * уместен только во втором случае — раньше он висел под кнопкой всегда.
 */
interface FormError {
  message: string;
  field: FormField | null;
  kind: 'validation' | 'send';
}

export default function BookingFormClient({ tourId, basePrice, maxParticipants = 10, tourTitle, priceUnit, duration, initialDate, cancellationTerms, askSeatsFirst = false }: BookingFormProps) {
  const router = useRouter();
  const [plainBooking, setPlainBooking] = useState(!askSeatsFirst);
  const [seatsOpen, setSeatsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // Сообщение об ошибке обязано оказаться на экране: кнопка внизу длинной
  // формы, над ней липкая панель, и отказ, выведенный вне видимой зоны,
  // для человека не существует. `center` оставляет его выше нижней панели.
  useEffect(() => {
    const el = errorRef.current;
    if (!error || !el || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);
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
    booking_date: initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : '',
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
  const unit = normalizePriceUnit(priceUnit);
  const days = unit === 'per_day_per_person' && duration ? tourDurationDays(duration) : 1;

  /**
   * Цена на ВЫБРАННУЮ дату — с правилами оператора (27.09).
   *
   * Без даты правил не существует: `last_minute` и сезон считаются ОТ ДАТЫ, и
   * до её выбора показывается цена оператора — она же и запишется, если правил
   * нет. Считает сервер (`GET /api/tours/[id]/price`, то же правило
   * `lib/tours/honest-price`, которым считает бронь): цену от клиента
   * `reserveBooking` не принимает и не примет.
   *
   * `status` — три исхода (§4.0). `checked` — сверено с датой; `base` — даты
   * ещё нет; `unchecked` — сверить не удалось, и об этом сказано вслух. Молча
   * показать базовую цену вместо непроверенной нельзя: у правила бывает
   * НАДБАВКА (высокий сезон, заполненная дата), и тогда человек увидел бы
   * сумму меньше той, что придёт в заявке.
   */
  const [priced, setPriced] = useState<{
    status: 'base' | 'checked' | 'unchecked';
    total: number;
    baseTotal: number;
    label: string | null;
  }>({ status: 'base', total: 0, baseTotal: 0, label: null });

  const chosenDate = formData.booking_date;
  useEffect(() => {
    if (!chosenDate) {
      setPriced({ status: 'base', total: 0, baseTotal: 0, label: null });
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(
          `/api/tours/${tourId}/price?date=${encodeURIComponent(chosenDate)}&guests=${participants}`,
          { signal: ctrl.signal },
        );
        const data = await res.json() as {
          success?: boolean; total?: number; baseTotal?: number; label?: string | null;
        };
        if (!res.ok || data.success !== true || typeof data.total !== 'number') {
          setPriced({ status: 'unchecked', total: 0, baseTotal: 0, label: null });
          return;
        }
        setPriced({
          status: 'checked',
          total: data.total,
          baseTotal: typeof data.baseTotal === 'number' ? data.baseTotal : data.total,
          label: data.label ?? null,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPriced({ status: 'unchecked', total: 0, baseTotal: 0, label: null });
      }
    })();
    return () => ctrl.abort();
  }, [tourId, chosenDate, participants]);

  // Та же функция, что считает сумму заявки на сервере (reserve.ts): сумма
  // на экране и в заявке совпадают, и тур «за группу» не множится на людей.
  const basePriceTotal = bookingTotal({ basePrice, priceUnit, participants, duration });
  const totalPrice = priced.status === 'checked' ? priced.total : basePriceTotal;
  const struckTotal = priced.status === 'checked' && priced.baseTotal > priced.total ? priced.baseTotal : null;

  // Человек начал править — прежний отказ больше не про то, что на экране.
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(null);
  };
  const setDate = (date: string) => {
    setFormData(prev => ({ ...prev, booking_date: date }));
    setError(null);
  };
  const setConsent = (v: boolean) => {
    setPdConsent(v);
    setError(null);
  };
  /** Подсветка поля, которое назвал отказ: рамка --danger и aria-invalid. */
  const invalid = (f: FormField) => error?.field === f;
  const invalidProps = (f: FormField) => invalid(f)
    ? { 'aria-invalid': true as const, 'aria-describedby': 'booking-error', style: { borderColor: 'var(--danger)' } }
    : {};

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.booking_date) {
      setError({ message: 'Выберите дату заезда', field: 'booking_date', kind: 'validation' });
      return;
    }
    // Согласие проверяется и здесь, а не только выключенной кнопкой: гейт,
    // держащийся одним `disabled`, переживает ровно до первой правки вёрстки.
    if (!pdConsent) {
      setError({ message: 'Нужно согласие на обработку данных, чтобы мы могли связаться с вами', field: 'pd_consent', kind: 'validation' });
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
    if (!formData.tourist_email.trim()) {
      setError({ message: GUEST_EMAIL_REQUIRED_MESSAGE, field: 'tourist_email', kind: 'validation' });
      return;
    }
    const phone = normalizePhone(formData.tourist_phone);
    if (!phone) {
      setError({ message: 'Проверьте телефон: нужен номер из 10–15 цифр, например +7 900 000 00 00', field: 'tourist_phone', kind: 'validation' });
      return;
    }
    setLoading(true);
    setError(null);
    // Поле, которое назвал сервер, — чтобы подсветить именно его.
    let serverField: FormField | null = null;

    // Код агентской ссылки: сперва адресная строка, потом память (30 дней,
    // ReferralCapture). До 26.09 эта форма — главная дверь брони — кода не
    // слала вовсе, и продажа по ссылке агента терялась всякий раз, когда
    // турист бронировал с карточки тура (issue #1978, пакет A кабинета агента).
    const referralCode = agentReferralForBooking(window.location.search, Date.now()) ?? undefined;

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
          // Почта необязательна (решение владельца 24.09): пустую строку не
          // шлём вовсе — сервер ждёт `email().optional()`, и '' он отверг бы
          // как «неверный формат».
          tourist_email: formData.tourist_email.trim() || undefined,
          participants_count: participants,
          // СОСТОЯНИЕ галочки, а не литерал `true`. Девять соседних форм шлют
          // литерал, и это работает лишь пока кнопка выключена: снимут
          // `disabled` — согласие уедет без галочки, а сервер не отличит,
          // потому что проверяет, ЧТО пришло, а не что человек нажимал.
          pd_consent: pdConsent,
          referral_code: referralCode,
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
        serverField = typeof data === 'object' && data !== null && 'field' in data
          ? asFormField((data as Record<string, unknown>).field)
          : null;
        throw new Error(msg);
      }

      const id = typeof data === 'object' && data !== null && 'booking_id' in data
        ? (data as Record<string, unknown>).booking_id
        : null;
      if (!id) throw new Error('Заявка создана, но ID не получен. Проверьте раздел «Заявки».');
      // Ключ брони приходит один раз и живёт только в этой ссылке: номер
      // брони подтверждения больше не открывает (миграция 943).
      const token = typeof data === 'object' && data !== null && 'access_token' in data
        ? String((data as Record<string, unknown>).access_token)
        : '';
      router.push(`/booking-success/${id}?t=${encodeURIComponent(token)}`);
    } catch (err) {
      // Отказ не глушится (§4.0): сообщение — человеку, причина сети — в консоль.
      const ours = err instanceof Error && /[А-Яа-яЁё]/.test(err.message);
      if (!ours) console.error('[BookingForm] отправка не удалась', err);
      const message = ours
        ? (err as Error).message
        : 'Не удалось отправить заявку. Проверьте связь и попробуйте ещё раз.';
      // Поле назвал сервер — это отказ по вводу, повтор тут не поможет.
      setError({ message, field: serverField, kind: serverField ? 'validation' : 'send' });
    } finally {
      setLoading(false);
    }
  };

  const maxOpts = Math.min(maxParticipants, 12);

  if (!plainBooking) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="ds-h2 mb-0.5">Спросить свободные места</h2>
          {tourTitle && <p className="text-sm text-[var(--text-secondary)]">{tourTitle}</p>}
        </div>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
          У этого тура нет расписания: оператор собирает группы под запрос. Назовите дату и число людей —
          оператор ответит в мессенджер в течение 2 часов. Если места есть, заявка сразу станет подтверждённой,
          {platformAcceptsPayments()
            ? 'и по ссылке из ответа её можно будет оплатить.'
            : 'а оплату вы внесёте оператору напрямую — Ведар платежи не принимает.'}
        </p>
        <button type="button" className="ds-btn ds-btn-primary w-full" onClick={() => { markFunnelStart(); setSeatsOpen(true); }}>
          Спросить места у оператора
        </button>
        <button type="button" className="inline-flex items-center min-h-[44px] text-sm text-[var(--ocean)] hover:underline" onClick={() => setPlainBooking(true)}>
          Оставить обычную заявку
        </button>
        {seatsOpen && (
          <SeatRequestForm
            tour={{ id: String(tourId), title: tourTitle ?? 'Тур' }}
            defaultDate={initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : ''}
            defaultParticipants={1}
            onClose={() => setSeatsOpen(false)}
            source="tour_card"
          />
        )}
      </div>
    );
  }

  return (
    // Без ds-card: форма стоит внутри карточки aside (_TourDetailClient), и
    // вторая рамка с p-6 съедала 48px ширины — итог рвался на «52 000 / ₽»,
    // кнопка на две строки, ячейки календаря 32px (аудит 24.09, П2).
    <form onSubmit={handleSubmit} onFocusCapture={markFunnelStart} className="space-y-5">
      <div>
        <h2 className="ds-h2 mb-0.5">Оставить заявку на тур</h2>
        {tourTitle && <p className="text-sm text-[var(--text-secondary)]">{tourTitle}</p>}
      </div>

      {/* Дата — первое поле */}
      <div>
        <label htmlFor="booking-date" className="ds-label flex items-center gap-1.5 mb-1.5">
          <Calendar className="w-3.5 h-3.5" />
          Дата заезда *
        </label>
        <TourDateField
          tourId={tourId}
          tourTitle={tourTitle}
          value={formData.booking_date}
          onChange={setDate}
          inputId="booking-date"
          invalid={invalid('booking_date')}
        />
      </div>

      {/* Участники */}
      <div>
        <label htmlFor="booking-participants" className="ds-label flex items-center gap-1.5 mb-1.5">
          <Users className="w-3.5 h-3.5" />
          Количество участников *
        </label>
        <select
          id="booking-participants"
          name="participants_count"
          value={formData.participants_count}
          onChange={handleChange}
          className="ds-input w-full"
          {...invalidProps('participants_count')}
        >
          {Array.from({ length: maxOpts }, (_, i) => i + 1).map(n => (
            <option key={n} value={n}>{n} {n === 1 ? 'человек' : n < 5 ? 'человека' : 'человек'}</option>
          ))}
        </select>
      </div>

      {/* Контакты */}
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label htmlFor="booking-name" className="ds-label flex items-center gap-1.5 mb-1.5">
            <User className="w-3.5 h-3.5" />
            Имя *
          </label>
          <input
            id="booking-name"
            type="text"
            name="tourist_name"
            autoComplete="name"
            value={formData.tourist_name}
            onChange={handleChange}
            placeholder="Иван Иванов"
            className="ds-input w-full"
            required
            {...invalidProps('tourist_name')}
          />
        </div>
        <div>
          <label htmlFor="booking-phone" className="ds-label flex items-center gap-1.5 mb-1.5">
            <Phone className="w-3.5 h-3.5" />
            Телефон *
          </label>
          <input
            id="booking-phone"
            type="tel"
            inputMode="tel"
            name="tourist_phone"
            autoComplete="tel"
            value={formData.tourist_phone}
            onChange={handleChange}
            placeholder="+7 900 000 00 00"
            className="ds-input w-full"
            required
            {...invalidProps('tourist_phone')}
          />
        </div>
        <div>
          {/* Почта обязательна (решение владельца 04.10, пересматривает 24.09):
              подтверждение оператора и ссылка на оплату доходят до гостя
              только письмом. Без неё подтверждённую заявку оплатить нечем. */}
          <label htmlFor="booking-email" className="ds-label flex items-center gap-1.5 mb-1.5">
            <Mail className="w-3.5 h-3.5" />
            Email
          </label>
          <input
            id="booking-email"
            type="email"
            name="tourist_email"
            autoComplete="email"
            required
            value={formData.tourist_email}
            onChange={handleChange}
            placeholder="ivan@example.com"
            className="ds-input w-full"
            aria-describedby="booking-email-hint"
            {...invalidProps('tourist_email')}
          />
          <p id="booking-email-hint" className="mt-1.5 text-xs text-[var(--text-secondary)]">
            {platformAcceptsPayments()
              ? 'Пришлём ссылку на заявку, а когда оператор подтвердит — на оплату.'
              : 'Пришлём ссылку на заявку и сообщим, когда оператор подтвердит.'}
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="booking-requests" className="ds-label flex items-center gap-1.5 mb-1.5">
          <MessageSquare className="w-3.5 h-3.5" />
          Пожелания оператору
        </label>
        <textarea
          id="booking-requests"
          name="special_requests"
          value={formData.special_requests}
          onChange={handleChange}
          className="ds-input w-full resize-none"
          rows={3}
          placeholder="Особые пожелания, вопросы по снаряжению..."
          {...invalidProps('special_requests')}
        />
      </div>

      <PdConsentCheckbox checked={pdConsent} onChange={setConsent} id="pd-consent-tour-booking" />

      {/* Отказ — бледная подложка из --danger и текст --danger. Прежняя
          `bg-[var(--danger)] bg-opacity-10` в Tailwind 3 давала СПЛОШНОЙ
          красный фон: красный текст на красном, сообщение не читалось вовсе
          (аудит 24.09). bg-opacity на var()-цвет не действует — только
          color-mix. Стоит над итогом, у кнопки, где человек смотрит. */}
      {error && (
        <div
          ref={errorRef}
          id="booking-error"
          role="alert"
          className="flex items-start gap-2 rounded-lg border p-3 text-sm text-[var(--danger)] scroll-mt-24"
          style={{
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)',
          }}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <p>{error.message}</p>
            {/* Совет про повтор — только когда отправка не удалась. Про повтор
                говорим ЧЕСТНО: идемпотентности у создания брони нет (ни ключа,
                ни ON CONFLICT — проверено 14.09), и обещание «заявка не
                продублируется» было бы прямым враньём. Ограничение частоты
                5/мин повтор не отменяет. */}
            {error.kind === 'send' && (
              <p className="text-xs">
                Подождите минуту и попробуйте снова, а не нажимайте несколько раз подряд.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Итог — колонкой: сумма целиком одной строкой, под ней кнопка во всю
          ширину. В строку с кнопкой сумма не помещалась и рвалась. */}
      <div className="border-t border-[var(--border)] pt-4 space-y-3">
        <div>
          <p className="text-sm text-[var(--text-secondary)]">
            {unit === 'per_tour'
              ? `${formatPrice(basePrice)} за группу · ${participants} чел.`
              : unit === 'per_day_per_person' && days > 1
              ? `${formatPrice(basePrice)} × ${participants} чел. × ${days} дн.`
              : `${formatPrice(basePrice)} × ${participants} чел.`}
          </p>
          {/* `whitespace-nowrap` на строке целиком: «52 000 ₽» не может
              порваться на «52 000 / ₽» (сторож booking-form-p2). `flex-wrap`
              при этом оставлен — сами суммы могут разойтись по строкам на
              узком экране, а числа внутри них нет. */}
          <p className="flex flex-wrap items-baseline gap-2 whitespace-nowrap">
            {/* Прежняя сумма зачёркнутой — иначе скидка это просто другое
                число, и человек не поймёт, почему оно не как в каталоге.
                `--text-secondary`, не `--text-muted`: muted в этой форме
                запрещён, он для плейсхолдеров (сторож booking-form-p2). */}
            {struckTotal !== null && (
              <span className="text-base text-[var(--text-secondary)] line-through">
                {formatPrice(struckTotal)}
              </span>
            )}
            <span className="text-2xl font-bold text-[var(--text-primary)]">
              {formatPrice(totalPrice)}
            </span>
          </p>
          {/* Скидка называется словами: «−15%, последние места». */}
          {priced.status === 'checked' && priced.label && (
            <p className="mt-0.5 text-sm font-medium text-[var(--success)]">{priced.label}</p>
          )}
          {/* Третий исход: цену на дату сверить не удалось. Молчать нельзя —
              у правила бывает надбавка, и тогда показанное было бы МЕНЬШЕ
              того, что придёт в заявке. */}
          {priced.status === 'unchecked' && (
            <p className="mt-0.5 text-sm text-[var(--warning)]">
              Цену на эту дату сверить не удалось — итог подтвердит оператор в заявке.
            </p>
          )}
          {/* Условия отмены до отправки — как у тарифа в модуле отеля. Тем же
              правилом, что и настоящий возврат (computeTourRefund). */}
          {cancellationTerms && (
            <p className="mt-1.5 text-xs text-[var(--text-secondary)] leading-snug" data-cancellation-terms>
              {cancellationTermsLine(cancellationTerms, formData.booking_date || null)}
            </p>
          )}
        </div>
        {/* Без даты кнопка выключена — и обязана ВЫГЛЯДЕТЬ выключенной и
            говорить почему: прогулка 10.09 нашла её оранжевой и молчащей
            (issue #1780), человек жал и не понимал, что не так.
            При отправке текст остаётся рядом со спиннером — ширина кнопки
            не прыгает, и видно, что происходит. */}
        <button
          type="submit"
          disabled={loading || !formData.booking_date || !pdConsent}
          aria-describedby={!formData.booking_date || !pdConsent ? 'booking-submit-hint' : undefined}
          aria-busy={loading || undefined}
          className="ds-btn ds-btn-primary w-full inline-flex items-center justify-center gap-2 whitespace-nowrap px-6 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Отправляем…
            </>
          ) : (
            <>
              Оставить заявку
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </>
          )}
        </button>
        {/* Причина, по которой кнопка выключена, называется КОНКРЕТНАЯ. Одно
            «заполните форму» на два разных препятствия заставляет искать
            глазами, чего не хватает (урок #1780). Текст — основным цветом,
            предупреждает иконка: жёлтый текст на белом давал 2.5:1. */}
        {!formData.booking_date ? (
          <p id="booking-submit-hint" className="flex items-start gap-1.5 text-xs text-[var(--text-primary)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px text-[var(--warning)]" aria-hidden="true" />
            Сначала выберите дату заезда в календаре выше.
          </p>
        ) : !pdConsent ? (
          <p id="booking-submit-hint" className="flex items-start gap-1.5 text-xs text-[var(--text-primary)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px text-[var(--warning)]" aria-hidden="true" />
            Отметьте согласие на обработку данных — без него мы не сможем связаться с вами.
          </p>
        ) : (
          <p className="text-xs text-[var(--text-secondary)]">
            После создания заявки откроется страница заявки с дальнейшими шагами. Оператор получит уведомление автоматически.
          </p>
        )}
      </div>
    </form>
  );
}
