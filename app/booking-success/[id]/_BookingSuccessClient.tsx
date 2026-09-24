'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Script from 'next/script';
import {
  CheckCircle, Copy, Home, Calendar, Users, Phone,
  MessageSquare, Loader2, AlertCircle, CreditCard, BadgeCheck, ExternalLink,
  FileText, Ticket, QrCode, XCircle, Info,
} from 'lucide-react';
import SbpQrPayment from '@/components/marketplace/SbpQrPayment';
import { canOfferPayment, hasOperatorContacts, successHeadline } from '@/lib/bookings/success-view';

interface BookingData {
  id: number;
  tour_title: string;
  booking_date: string;
  participants_count: number;
  tourist_name: string;
  status: string;
  payment_status: string;
  total_price: number;
  operator_name: string;
  operator_phone: string | null;
  operator_telegram: string | null;
  cp_public_id: string;
  sbp_available: boolean;
  /** Есть ли у брони email — единственный другой способ вернуться к ссылке (#1889). */
  has_email: boolean;
}

declare global {
  interface Window {
    cp?: {
      CloudPayments: new () => {
        charge: (payment: Record<string, unknown>, callbacks: {
          onSuccess: (opts: { transactionId: number }) => void;
          onFail: (reason: string, opts: { reasonCode?: number }) => void;
          onComplete: (result: unknown, opts: unknown) => void;
        }) => void;
      };
    };
  }
}

export default function BookingSuccessClient() {
  const params    = useParams();
  const bookingId = parseInt(params.id as string, 10);
  /**
   * Ключ брони из ссылки (`?t=`). Номер брони сам по себе больше ничего не
   * открывает: до 08.09 по нему перебором доставались имя туриста, цена и
   * токен на PDF с телефоном и почтой (миграция 943).
   *
   * Читается из window, а не из серверных searchParams: страница клиентская,
   * а ключ не должен попасть ни в кэш, ни в разметку.
   *
   * `null` — ключ ЕЩЁ НЕ ПРОЧИТАН (первый рендер, до эффекта), `''` — прочитан
   * и его нет. До 24.09 оба состояния были пустой строкой: первый прогон
   * эффекта загрузки решал «не найдено» раньше, чем ключ успевали прочесть, и
   * сразу после настоящей заявки человек видел «Бронирование не найдено» под
   * «Заявка создана» — на медленной сети секундами (аудит П3, #24/#27).
   */
  const [accessToken, setAccessToken] = useState<string | null>(null);
  useEffect(() => {
    try {
      setAccessToken(new URLSearchParams(window.location.search).get('t') ?? '');
    } catch { setAccessToken(''); /* ключа нет — ниже будет честное «не найдено» */ }
  }, []);

  /**
   * Вошёл ли смотрящий: `null` — не знаем (не спросили или сеть не ответила).
   * «Мои бронирования» показываются только при `true`: гостевая бронь
   * хранится без user_id, и гостя эта кнопка вела на вход, после которого
   * заявки в списке всё равно нет (#76/#86/#92).
   */
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/state', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { data?: { authenticated?: boolean } } | null) => {
        if (alive && typeof d?.data?.authenticated === 'boolean') setAuthed(d.data.authenticated);
      })
      .catch(() => { /* связи нет — остаётся «не знаем», кнопку не показываем */ });
    return () => { alive = false; };
  }, []);

  const [booking,  setBooking]  = useState<BookingData | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [copied,   setCopied]   = useState(false);
  const [cpReady,  setCpReady]  = useState(false);
  const [paying,   setPaying]   = useState(false);
  const [paid,     setPaid]     = useState(false);
  const [payMethod, setPayMethod] = useState<'card' | 'sbp'>('card');

  /**
   * Почему исходов ТРИ, а не два (аудит 08.09, находка missing_third_state).
   *
   * Сервер различает 404 «ключ не подошёл» и 503 «не смог проверить доступ»
   * (отказ базы). Экран до этой правки схлопывал оба в одну надпись «Не
   * удалось загрузить данные» — и турист с ВЕРНОЙ ссылкой при сбое базы
   * видел ровно то же, что посторонний с чужим номером. Ему при этом не
   * доставалось единственного, что здесь помогает: «попробуйте позже».
   *
   * `unknown` — сетевой отказ или неожиданный код: тоже не «не найдено».
   */
  const [failure, setFailure] = useState<'not_found' | 'unavailable' | 'unknown' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (accessToken === null) return;  // ключ ещё не прочитан — решать рано, крутится спиннер
    if (!accessToken) { setFailure('not_found'); setLoading(false); return; }  // без ключа роут ответит 404
    // Каждый запрос начинается с чистого листа: иначе исход прошлого прогона
    // («не найдено», «не дозвонились») висит на экране, пока идёт новый.
    setLoading(true);
    setFailure(null);
    let alive = true;
    void (async () => {
      try {
        const res  = await fetch(`/api/hub/bookings/${bookingId}?token=${encodeURIComponent(accessToken)}`);
        const json = await res.json().catch(() => null) as { success?: boolean; data?: BookingData } | null;
        if (!alive) return;
        if (res.ok && json?.success && json.data) {
          setBooking(json.data);
          setFailure(null);
        } else if (res.status === 503) {
          setFailure('unavailable');
        } else if (res.status === 404) {
          setFailure('not_found');
        } else {
          setFailure('unknown');
        }
      } catch {
        // Сети не было вовсе — это не «брони нет».
        if (alive) setFailure('unknown');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [bookingId, accessToken, attempt]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(String(bookingId));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /**
   * Ссылка на эту же страницу с ключом — единственный способ сюда вернуться,
   * когда почты у брони нет (#1889). Копируем ПОЛНЫЙ URL (window.location.href,
   * не собранный вручную), а не только `bookingId`, как в handleCopy выше —
   * тот для другой цели (продиктовать номер оператору по телефону).
   */
  const [linkCopied, setLinkCopied] = useState(false);
  const handleCopyLink = () => {
    try {
      void navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { /* буфер обмена недоступен — ссылка всё равно видна в адресной строке */ }
  };

  const handlePay = useCallback(() => {
    if (!booking || !window.cp || !cpReady) return;
    setPaying(true);
    const widget = new window.cp.CloudPayments();
    widget.charge(
      {
        publicId:    booking.cp_public_id,
        description: `Тур «${booking.tour_title}» — бронь #${booking.id}`,
        amount:      booking.total_price,
        currency:    'RUB',
        invoiceId:   String(booking.id),
        accountId:   booking.tourist_name,
        data:        { bookingId: booking.id, source: 'booking_success' },
      },
      {
        onSuccess: () => { setPaying(false); setPaid(true); },
        onFail:    () => { setPaying(false); },
        onComplete: () => { setPaying(false); },
      }
    );
  }, [booking, cpReady]);

  // Без «г.»: «28 сентября 2026 / г.» переносилось в узкой колонке (#87).
  const fmtDate  = (d: string) =>
    new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
  const fmtPrice = (p: number) =>
    p.toLocaleString('ru-RU') + ' ₽';

  const alreadyPaid  = paid || booking?.payment_status === 'paid';
  /**
   * Оплата — только после подтверждения оператором (решение владельца 24.09,
   * развилка 4). Карточка тура обещает «оплата только после подтверждения»;
   * до этой правки статус 'new' сразу получал крупную «Перейти к оплате».
   * Правило живёт в lib/bookings/success-view (сторож booking-success-page).
   */
  const needsPayment = Boolean(booking && !alreadyPaid && canOfferPayment(booking.status));
  /** Заявка ещё у оператора: даты он не подтвердил, платить рано. */
  const awaitingOperator = Boolean(booking && !alreadyPaid && booking.status === 'new');
  const contactsShown = booking ? hasOperatorContacts(booking) : false;

  // Способы считаются ПООТДЕЛЬНОСТИ. До 04.09 вкладка СБП была вложена внутрь
  // проверки ключа CloudPayments: настроенная Точка не помогала, если у карты
  // ключа нет. Ключ при этом читался под другим именем, чем документирован, —
  // и весь блок исчезал молча, оставляя обещание «переходите к оплате».
  const canPayCard = Boolean(needsPayment && booking?.cp_public_id);
  const canPaySbp  = Boolean(needsPayment && booking?.sbp_available);
  const noPayWay   = Boolean(needsPayment && !canPayCard && !canPaySbp);
  // Заголовок — из правила в success-view: «подтвердил… к оплате» только
  // при реально предлагаемой оплате, у отмены/завершения свои слова.
  const headline = booking
    ? successHeadline({ status: booking.status, alreadyPaid, needsPayment, noPayWay })
    : null;

  useEffect(() => {
    if (payMethod === 'card' && !canPayCard && canPaySbp) setPayMethod('sbp');
  }, [payMethod, canPayCard, canPaySbp]);

  // Определяем: открыто ли в Telegram WebView (блокирует попапы)
  const isInTgWebView = typeof navigator !== 'undefined' &&
    /Telegram/i.test(navigator.userAgent);

  return (
    <div className="ds-page min-h-[100dvh] flex items-start justify-center pb-6 sm:pb-12 px-4">
      <Script
        src="https://widget.cloudpayments.ru/bundles/cloudpayments.js"
        onLoad={() => setCpReady(true)}
        strategy="afterInteractive"
      />

      <div className="w-full max-w-lg">

        {/* Заголовок. «Заявка создана» — только когда бронь РЕАЛЬНО прочитана;
            до ответа — нейтральное «Проверяем заявку…» (#27). */}
        <div className="text-center mb-6">
          <div className="inline-block mb-4">
            {headline
              ? headline.tone === 'paid'
                ? <BadgeCheck size={56} className="text-[var(--success)]" />
                : headline.tone === 'created'
                  ? <CheckCircle size={56} className="text-[var(--success)]" />
                  : headline.tone === 'cancelled'
                    ? <XCircle size={56} className="text-[var(--text-muted)]" />
                    : <Info size={56} className="text-[var(--text-muted)]" />
              : loading
                ? null /* спиннер один — в карточке ниже */
                : <AlertCircle size={56} className="text-[var(--text-muted)]" />
            }
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-1"
            style={{ fontFamily: 'var(--font-playfair)' }}>
            {!headline
              ? loading ? 'Проверяем заявку…' : 'Не удалось открыть заявку'
              : headline.title}
          </h1>
          {headline?.subtitle && (
            <p className="text-sm text-[var(--text-secondary)]">{headline.subtitle}</p>
          )}
        </div>

        {/* Нет email — эта ссылка единственная (#1889): закрыл вкладку без
            сохранения, и вернуться к брони, PDF и оплате будет нечем.
            Предупреждаем ДО карточки с деталями, а не мельче внизу. */}
        {booking && !booking.has_email && (
          <div className="ds-card p-4 mb-5 border-2" style={{ borderColor: 'var(--warning)' }}>
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-[var(--warning)]" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  Сохрани эту ссылку сейчас
                </p>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                  Почту при бронировании не указывали — значит письма с этой ссылкой не будет,
                  и вернуться к заявке, оплате и документам можно только по ней. Закроешь вкладку
                  без сохранения — доступ к брони и своим данным восстановить будет нечем.
                  Кнопка «Скопировать ссылку на заявку» — внизу страницы.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Card */}
        <div className="ds-card p-5 sm:p-7 mb-5">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
            </div>
          ) : !booking ? (
            /* Три исхода различимы человеком, а не только сервером. */
            <div className="flex flex-col gap-3 text-[var(--text-secondary)]">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <span className="text-sm">
                  {failure === 'unavailable'
                    ? <>Не удалось проверить доступ к брони — попробуйте через минуту. Номер: <b>#{bookingId}</b></>
                    : failure === 'unknown'
                      ? <>Не дозвонились до сервера. Проверьте связь и повторите. Номер: <b>#{bookingId}</b></>
                      : <>Бронирование не найдено. Откройте ссылку из письма или из чата — по одному номеру бронь не открывается.</>}
                </span>
              </div>
              {failure !== 'not_found' && (
                <button
                  type="button"
                  onClick={() => { setLoading(true); setAttempt((n) => n + 1); }}
                  className="ds-btn ds-btn-secondary self-start text-sm"
                >
                  Повторить
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">

              {/* Booking number */}
              <div className="flex items-center justify-between pb-4 border-b border-[var(--border)]">
                <div>
                  <p className="text-[11px] text-[var(--text-muted)] mb-0.5">Номер брони</p>
                  <p className="text-2xl font-bold text-[var(--accent)]">#{booking.id}</p>
                </div>
                {/* 44px — минимальная тач-цель DS; была 16px (#86). */}
                <button type="button" onClick={handleCopy}
                  className="min-h-[44px] px-2 -mr-2 flex items-center gap-1.5 text-xs text-[var(--ocean)] hover:text-[var(--accent)] transition-colors">
                  <Copy size={14} />
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>

              {/* Tour */}
              <div className="pb-4 border-b border-[var(--border)]">
                <p className="text-[11px] text-[var(--text-muted)] mb-0.5">Тур</p>
                <p className="font-semibold text-[var(--text-primary)]">{booking.tour_title}</p>
              </div>

              {/* Date + participants */}
              <div className="grid grid-cols-2 gap-3 pb-4 border-b border-[var(--border)]">
                <div className="flex items-start gap-2">
                  <Calendar className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" />
                  <div>
                    <p className="text-[11px] text-[var(--text-muted)]">Дата</p>
                    <p className="text-sm font-medium text-[var(--text-primary)] whitespace-nowrap">{fmtDate(booking.booking_date)}</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Users className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" />
                  <div>
                    <p className="text-[11px] text-[var(--text-muted)]">Человек</p>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{booking.participants_count}</p>
                  </div>
                </div>
              </div>

              {/* Price */}
              <div className={needsPayment ? '' : 'pb-4 border-b border-[var(--border)]'}>
                <p className="text-[11px] text-[var(--text-muted)] mb-0.5">Сумма</p>
                <p className="text-2xl font-bold text-[var(--text-primary)]">{fmtPrice(booking.total_price)}</p>
              </div>

              {/* Заявка ещё у оператора — следующий шаг словами, а не кнопка
                  оплаты (развилка 4). Контакты упоминаются, только если они
                  на экране есть (#75/#87). */}
              {awaitingOperator && (
                <div className="pt-1 px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
                  <p className="text-sm font-semibold text-[var(--text-primary)] mb-2">Что дальше</p>
                  <ol className="space-y-1.5 text-xs text-[var(--text-secondary)] leading-relaxed list-decimal pl-4">
                    <li>
                      Оператор подтверждает дату и детали.{' '}
                      {contactsShown
                        ? 'Если есть вопросы — его контакты ниже.'
                        : 'Он свяжется с вами по телефону, который вы указали.'}
                    </li>
                    <li>
                      После подтверждения оплата откроется на этой странице
                      {booking.has_email ? ' — та же ссылка есть в письме о заявке.' : '.'}
                    </li>
                  </ol>
                </div>
              )}

              {/* Оплатить нечем — говорим вслух, а не прячем блок.
                  Спрятанный блок читается как «так задумано», и турист уходит
                  думать, что бронь оплаты не требует. Тон нейтральный: это
                  следующий шаг, а не отказ (#87). */}
              {noPayWay && (
                <div className="pt-1 flex items-start gap-2.5 px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
                  <CreditCard className="w-4 h-4 shrink-0 mt-0.5 text-[var(--ocean)]" />
                  <div>
                    <p className="text-sm font-semibold text-[var(--text-primary)]">Онлайн-оплата недоступна</p>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                      Заявка сохранена под номером выше. Мы передали её оператору,
                      {contactsShown
                        ? ' оплатить можно будет напрямую по его контактам ниже.'
                        : ' он свяжется с вами по телефону, который вы указали, и подскажет, как оплатить.'}
                    </p>
                  </div>
                </div>
              )}

              {/* Pay */}
              {(canPayCard || canPaySbp) && (
                <div className="pt-1 space-y-3">
                  <p className="text-[11px] text-center text-[var(--text-muted)]">
                    Перед оплатой убедитесь, что дата, количество участников и условия тура вам подходят.
                  </p>

                  {/* Переключатель — только когда способов правда два */}
                  {canPayCard && canPaySbp && (
                    <div className="flex rounded-lg border border-[var(--border)] p-1 gap-1">
                      <button
                        type="button"
                        onClick={() => setPayMethod('card')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-colors ${
                          payMethod === 'card'
                            ? 'bg-[var(--accent)] text-white'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                        }`}
                      >
                        <CreditCard className="w-3.5 h-3.5" />
                        Картой
                      </button>
                      <button
                        type="button"
                        onClick={() => setPayMethod('sbp')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-colors ${
                          payMethod === 'sbp'
                            ? 'bg-[var(--accent)] text-white'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                        }`}
                      >
                        <QrCode className="w-3.5 h-3.5" />
                        По QR (СБП)
                      </button>
                    </div>
                  )}

                  {canPayCard && payMethod === 'card' ? (
                    <div className="space-y-2">
                      {/* Telegram WebView warning */}
                      {isInTgWebView && (
                        <a
                          href={`https://vedarai.ru/booking-success/${booking.id}?t=${encodeURIComponent(accessToken ?? "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] transition-colors"
                        >
                          <ExternalLink size={14} />
                          Открыть в браузере для оплаты
                        </a>
                      )}
                      <button
                        onClick={handlePay}
                        disabled={!cpReady || paying}
                        className="w-full flex items-center justify-center gap-2 px-5 py-4 rounded-lg font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50 text-base"
                        style={{ background: 'var(--accent)' }}
                      >
                        {paying
                          ? <><Loader2 className="w-4 h-4 animate-spin" /> Обработка...</>
                          : !cpReady
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Загрузка...</>
                            : <><CreditCard className="w-4 h-4" /> Перейти к оплате {fmtPrice(booking.total_price)}</>
                        }
                      </button>
                      <p className="text-[11px] text-center text-[var(--text-muted)]">
                        Безопасная оплата картой · CloudPayments
                      </p>
                    </div>
                  ) : (
                    <SbpQrPayment
                      bookingId={booking.id}
                      amount={booking.total_price}
                      onPaid={() => setPaid(true)}
                    />
                  )}
                </div>
              )}

              {/* Paid badge */}
              {alreadyPaid && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg"
                  style={{ background: 'color-mix(in srgb, var(--success) 15%, transparent)' }}>
                  <BadgeCheck className="w-4 h-4 shrink-0 text-[var(--success)]" />
                  <p className="text-sm font-semibold text-[var(--success)]">Оплата подтверждена</p>
                </div>
              )}

              {/* Operator */}
              {contactsShown && (
                <div className="pt-3 border-t border-[var(--border)]">
                  <p className="text-[11px] text-[var(--text-muted)] mb-2">Оператор</p>
                  <p className="text-sm font-medium text-[var(--text-primary)] mb-2">{booking.operator_name}</p>
                  <div className="flex flex-wrap gap-3">
                    {booking.operator_phone && (
                      <a href={`tel:${booking.operator_phone}`}
                        className="flex items-center gap-1.5 text-sm text-[var(--ocean)] hover:text-[var(--accent)] transition-colors">
                        <Phone className="w-4 h-4" />
                        {booking.operator_phone}
                      </a>
                    )}
                    {booking.operator_telegram && (
                      <a href={`https://t.me/${booking.operator_telegram.replace('@', '')}`}
                        target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-sm text-[var(--ocean)] hover:text-[var(--accent)] transition-colors">
                        <MessageSquare className="w-4 h-4" />
                        Telegram
                      </a>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] mt-2">
                    По этим контактам можно уточнить программу, экипировку и другие детали до выезда.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* PDF Documents */}
        {booking && (
          <div className="flex gap-3 mb-3">
            <a
              href={`/api/hub/bookings/${booking.id}/pdf?type=voucher&token=${encodeURIComponent(accessToken ?? "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors"
            >
              <Ticket size={15} />
              Ваучер (PDF)
            </a>
            <a
              href={`/api/hub/bookings/${booking.id}/pdf?type=contract&token=${encodeURIComponent(accessToken ?? "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--ocean)] hover:text-[var(--ocean)] transition-colors"
            >
              <FileText size={15} />
              Договор (PDF)
            </a>
          </div>
        )}

        {/* CTAs. Главная кнопка одна. У гостя это «Скопировать ссылку на
            заявку»: гостевая бронь живёт по ссылке, а «Мои бронирования» вели
            его на вход, после которого заявки там нет (#76/#86/#92). Когда
            открыта оплата, главная — она, а ссылка уходит во вторые.
            Ссылки — сами <Link className="ds-btn">, без вложенной <button>. */}
        <div className="flex flex-col gap-3">
          {booking && (
            <button
              type="button"
              onClick={handleCopyLink}
              className={`ds-btn ${canPayCard || canPaySbp ? 'ds-btn-secondary' : 'ds-btn-primary'} w-full flex items-center justify-center gap-2`}
            >
              <Copy size={16} />
              {linkCopied ? 'Ссылка скопирована' : 'Скопировать ссылку на заявку'}
            </button>
          )}
          {authed === true && (
            <Link href="/hub/tourist/bookings" className="ds-btn ds-btn-secondary w-full flex items-center justify-center gap-2">
              Мои бронирования
            </Link>
          )}
          <Link href="/marketplace" className="ds-btn ds-btn-secondary w-full flex items-center justify-center gap-2">
            <Home size={16} />
            В каталог
          </Link>
        </div>

      </div>
    </div>
  );
}
