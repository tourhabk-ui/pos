'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {
  MapPin, Clock, CheckCircle2, XCircle, ChevronDown,
  ChevronRight, Users, Backpack, Shield, X, LifeBuoy,
  Calendar, Star, Share2, Heart, MessageSquare, PenLine,
  Phone, Send, AlertTriangle, Check, Video, Globe, MessageCircle,
} from 'lucide-react';
import TourReviewForm from '@/components/marketplace/TourReviewForm';
import { photoSrc } from '@/lib/images/variant';
import BookingFormClient from '@/components/marketplace/BookingFormClient';
import MessageOperatorButton from '@/components/marketplace/MessageOperatorButton';
import SafetyWarnings from '@/components/safety/SafetyWarnings';
import DescriptionWithFishLinks from '@/components/shared/DescriptionWithFishLinks';
import FishSeasonCalendar from '@/components/tours/FishSeasonCalendar';
import { detectFishSpecies } from '@/lib/fish-species';
import { plural } from '@/lib/home/data-freshness';

/* ─── Labels ─── */

/**
 * Подписи — из единого словаря (lib/tours/labels). Свои копии здесь держать
 * нельзя: именно так один тур получал разные подписи на разных страницах
 * (аудит 03.08 — `boat_trip` был подписан пятью способами, два из них «Сплав»).
 */
import {
  activityLabel, locationLabel, priceUnitLabel, difficultyLabel,
  DIFFICULTY_LABELS as DIFFICULTY_MAP,
} from '@/lib/tours/labels';

/* Шрифты платформы: Playfair — дисплей (голос края), JetBrains Mono — метки. */
const FD = 'var(--font-playfair)';
const FM = 'var(--font-jetbrains, ui-monospace, monospace)';

/* ─── Types ─── */

interface ProgramStep { title: string; text: string }

interface TourFull {
  id: number;
  title: string;
  description: string | null;
  short_description: string | null;
  base_price: string;
  price_old: string | null;
  price_unit: string | null;
  activity_type: string;
  location_type: string;
  location_name: string | null;
  latitude: string | null;
  longitude: string | null;
  meeting_point: string | null;
  tour_image: string | null;
  photos: string[] | null;
  max_participants: number;
  min_participants: number | null;
  duration_hours: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  difficulty: string | null;
  included: string[] | null;
  not_included: string[] | null;
  what_to_bring: string[] | null;
  /** DATE из БД приезжает объектом `Date` — тип это признаёт (см. query-модуль). */
  season_start: string | Date | null;
  season_end: string | Date | null;
  seasonal_only: boolean | null;
  weather_dependent: boolean | null;
  rating: string | null;
  review_count: number | null;
  operator_name: string;
  operator_id: string;
  /**
   * Программа дня — [{title,text}] из operator_tours.program (миграция 809).
   * Опционально: если миграция ещё не применилась, запрос отдаёт строку без
   * этих колонок (см. lib/tours/tour-detail-query) — блок просто не рисуется.
   */
  program?: unknown;
  /** Правила безопасности этого тура — operator_tours.safety_notes (809). */
  safety_notes?: string[] | null;
  /**
   * Контакты оператора — partners.contacts (телефон/Telegram/сайт). Форму
   * приводит к объекту серверный запрос (`toContactsRecord`): на проде колонка
   * могла остаться текстовой, и тогда сюда приезжала СТРОКА с JSON — карточка
   * молча теряла все контакты разом (владелец 09.08).
   */
  operator_contacts: Record<string, unknown> | null;
  /** Логотип партнёра — partners.logo_image. Нет логотипа — буквенный кружок. */
  operator_logo?: string | null;
}

interface TourReview {
  id: number;
  author_name: string;
  author_city: string | null;
  rating: number;
  comment: string;
  trip_date: string | null;
  photos?: string[] | null;
}

/* ─── Helpers ─── */

/** Программа приходит из JSONB — форму не гарантирует никто, разбираем защитно. */
function toProgram(v: unknown): ProgramStep[] {
  if (!Array.isArray(v)) return [];
  const out: ProgramStep[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ title: item.trim(), text: '' });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      if (title) out.push({ title, text });
    }
  }
  return out;
}

interface OperatorContact { label: string; href: string; icon: 'phone' | 'telegram' | 'video' | 'site' | 'whatsapp' | 'max' }

/**
 * Контакты оператора из partners.contacts. Показываем только то, что реально
 * лежит в БД — телефонов и чатов не выдумываем (§8).
 */
/** +79001234567 → «+7 900 123-45-67» — на кнопке номер должен читаться. */
function formatPhone(digits: string): string {
  const m = digits.match(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : digits;
}

function toContacts(v: unknown): OperatorContact[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const out: OperatorContact[] = [];

  const phone = typeof o.phone === 'string' ? o.phone.replace(/[^\d+]/g, '') : '';
  const phone2 = typeof o.phone2 === 'string' ? o.phone2.replace(/[^\d+]/g, '') : '';

  // Один номер — «Позвонить». Два — на кнопках сами номера: две одинаковые
  // кнопки «Позвонить» не говорят, чем отличаются, а турист в поле может
  // дозвониться только по одному из них.
  if (phone.length >= 11 && phone2.length >= 11) {
    out.push({ label: formatPhone(phone), href: `tel:${phone}`, icon: 'phone' });
    out.push({ label: formatPhone(phone2), href: `tel:${phone2}`, icon: 'phone' });
  } else if (phone.length >= 11) {
    out.push({ label: 'Позвонить', href: `tel:${phone}`, icon: 'phone' });
  }

  // WhatsApp (contacts.whatsapp, 844) — привычный канал туриста; номер в
  // E.164, wa.me принимает цифры без плюса.
  const wa = typeof o.whatsapp === 'string' ? o.whatsapp.replace(/[^\d]/g, '') : '';
  if (/^\d{10,15}$/.test(wa)) {
    out.push({ label: 'WhatsApp', href: `https://wa.me/${wa}`, icon: 'whatsapp' });
  }

  // Личный чат менеджера (contacts.telegram_contact, 841) — куда писать;
  // канал (telegram_channel, 834) — что смотреть. Подписи различают их.
  const tgc = typeof o.telegram_contact === 'string' ? o.telegram_contact.trim().replace(/^@/, '') : '';
  if (/^[A-Za-z0-9_]{5,32}$/.test(tgc)) {
    out.push({ label: 'Написать в Telegram', href: `https://t.me/${tgc}`, icon: 'telegram' });
  }

  const tg = typeof o.telegram_channel === 'string' ? o.telegram_channel : '';
  if (tg.startsWith('https://t.me/')) {
    out.push({ label: tgc ? 'Telegram-канал' : 'Telegram', href: tg, icon: 'telegram' });
  }

  // Живой канал с уловами и сплавами продаёт лучше любого текста — показываем,
  // если у партнёра он есть (владелец 07.08: TikTok «Камчатской рыбалки»).
  const tiktok = typeof o.tiktok === 'string' ? o.tiktok.trim().replace(/^@/, '') : '';
  if (/^[\w.]{2,24}$/.test(tiktok)) {
    out.push({ label: 'TikTok', href: `https://www.tiktok.com/@${tiktok}`, icon: 'video' });
  }

  // MAX (contacts.max) — мессенджер, на который переходят в РФ. Ссылки по
  // НОМЕРУ в MAX не существует: адрес всегда ведёт на профиль
  // (max.ru/u/… или max.ru/ник), а профиль знает только его владелец. Поэтому
  // кнопка появляется, лишь когда партнёр дал ссылку, и принимается только
  // адрес max.ru: выдуманный адрес — это мёртвая кнопка на карточке.
  const max = typeof o.max === 'string' ? o.max.trim() : '';
  if (/^https:\/\/max\.ru\/[A-Za-z0-9_@.\-/]{2,64}$/.test(max)) {
    out.push({ label: 'Написать в MAX', href: max, icon: 'max' });
  }

  // Сайт оператора (contacts.website, 842) — прозрачность партнёрства:
  // турист вправе сверить предложение с первоисточником (аудит 08.08, п.8).
  const site = typeof o.website === 'string' ? o.website.trim() : '';
  if (/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(site)) {
    out.push({ label: 'Сайт оператора', href: site, icon: 'site' });
  }

  return out;
}

function formatDuration(tour: TourFull): string | null {
  if (tour.duration_type === 'multi_day' && tour.multi_day_count) {
    const d = tour.multi_day_count;
    return `${d} ${d === 1 ? 'день' : d < 5 ? 'дня' : 'дней'}`;
  }
  if (tour.duration_type === 'half_day') return 'Полдня';
  if (tour.duration_type === 'day') return '1 день';
  if (tour.duration_hours) {
    const h = Number(tour.duration_hours);
    if (h < 24) return `${h} ч`;
    const d = Math.round(h / 24);
    return `${d} ${d === 1 ? 'день' : d < 5 ? 'дня' : 'дней'}`;
  }
  return null;
}

/** Принимает и строку, и `Date` из БД; на мусоре молча возвращает null. */
function formatSeason(start: string | Date | null, end: string | Date | null): string | null {
  if (!start || !end) return null;
  const months = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  const s = new Date(start), e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  return `${months[s.getMonth()]} — ${months[e.getMonth()]}`;
}

function formatPrice(p: number): string {
  return new Intl.NumberFormat('ru-RU').format(p) + ' ₽';
}

/* ─── Статус дня (fail-soft: нет данных — блока нет) ─── */

interface DayStatus { title: string | null; source: string; hasAlert: boolean }

function useDayStatus(): DayStatus | null {
  const [status, setStatus] = useState<DayStatus | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/public/safety-status', { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (!d || typeof d !== 'object') return;
        const data = (d as Record<string, unknown>).data;
        if (!data || typeof data !== 'object') return;
        const o = data as Record<string, unknown>;
        setStatus({
          title: typeof o.topTitle === 'string' ? o.topTitle : null,
          source: typeof o.source === 'string' ? o.source : 'КБГС РАН',
          hasAlert: o.hasAlert === true,
        });
      })
      .catch(() => { /* тихо: статус дня — необязательный блок */ });
    return () => ctrl.abort();
  }, []);

  return status;
}

/* ─── Fullscreen Lightbox ─── */

function Lightbox({ images, alt, startIdx, onClose }: {
  images: string[]; alt: string; startIdx: number; onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIdx);
  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center" onClick={onClose}>
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-11 h-11 rounded-full bg-black/40 flex items-center justify-center text-white hover:bg-black/60 transition-colors z-10"
        aria-label="Закрыть"
      >
        <X className="w-5 h-5" />
      </button>
      <div className="relative w-full h-full flex items-center justify-center p-4 sm:p-12" onClick={e => e.stopPropagation()}>
        <Image src={images[idx]} alt={`${alt} — фото ${idx + 1}`} fill className="object-contain" sizes="100vw" />
      </div>
      {images.length > 1 && (
        <>
          <button
            onClick={e => { e.stopPropagation(); setIdx(i => (i - 1 + images.length) % images.length); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 flex items-center justify-center text-white hover:bg-black/60 transition-colors"
            aria-label="Назад"
          >
            <ChevronRight className="w-6 h-6 rotate-180" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); setIdx(i => (i + 1) % images.length); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-black/40 flex items-center justify-center text-white hover:bg-black/60 transition-colors"
            aria-label="Далее"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={e => { e.stopPropagation(); setIdx(i); }}
                className={`h-2 rounded-full transition-all ${i === idx ? 'bg-white w-5' : 'bg-white/40 w-2'}`}
                aria-label={`Фото ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Stars ─── */

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} className={`w-4 h-4 ${i <= rating ? 'text-[var(--warning)] fill-[var(--warning)]' : 'text-[var(--text-muted)]'}`} />
      ))}
    </span>
  );
}

/* ─── Section eyebrow ─── */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="w-4 h-px bg-[var(--accent)]" />
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]" style={{ fontFamily: FM }}>
        {children}
      </span>
    </div>
  );
}

function SectionTitle({ children, icon: Icon, iconColor }: {
  children: React.ReactNode; icon?: React.ElementType; iconColor?: string;
}) {
  return (
    <h2
      className="mb-4 flex items-center gap-2.5 text-[var(--text-primary)]"
      style={{ fontFamily: FD, fontWeight: 700, fontSize: 'clamp(20px,2.6vw,26px)', letterSpacing: '-0.02em' }}
    >
      {Icon && <Icon className="w-5 h-5 shrink-0" style={{ color: iconColor ?? 'var(--ocean)' }} />}
      {children}
    </h2>
  );
}

/* ─── Main Component ─── */

export default function TourDetailClient({ tour, reviews = [] }: { tour: TourFull; reviews?: TourReview[] }) {
  const router = useRouter();
  const dayStatus = useDayStatus();
  const [wishlisted, setWishlisted] = useState(false);
  const [wishlistLoading, setWishlistLoading] = useState(false);
  const [wishlistError, setWishlistError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(0);
  const [packed, setPacked] = useState<Set<number>>(new Set());

  // Реальное состояние избранного при загрузке. Раньше wishlisted всегда
  // стартовал false: после перезагрузки тур «выпадал» из избранного, а ошибки
  // глотались молча — снаружи это «кнопка не работает» (владелец 07.08).
  useEffect(() => {
    fetch('/api/tourist/wishlist?type=tour')
      .then(r => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        const rows = (j as { data?: Array<{ item_id: string }> } | null)?.data;
        if (Array.isArray(rows) && rows.some(x => String(x.item_id) === String(tour.id))) {
          setWishlisted(true);
        }
      })
      .catch(() => { /* гость — просто пустое сердце */ });
  }, [tour.id]);

  const handleWishlist = useCallback(async () => {
    if (wishlistLoading) return;
    setWishlistLoading(true);
    setWishlistError(null);
    try {
      const res = await fetch('/api/tourist/wishlist', {
        method: wishlisted ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemType: 'tour', itemId: String(tour.id) }),
      });
      if (res.status === 401) { router.push(`/auth/login?from=/marketplace/tours/${tour.id}`); return; }
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (res.ok && data.success !== false) {
        setWishlisted(w => !w);
      } else {
        // Причина словами, не молчание: «Профиль не найден» и «кнопка не
        // работает» — разные проблемы, и различить их может только текст.
        setWishlistError(data.error ?? 'Не удалось обновить избранное');
      }
    } catch {
      setWishlistError('Нет связи с сервером');
    } finally { setWishlistLoading(false); }
  }, [tour.id, wishlisted, wishlistLoading, router]);

  const handleShare = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: tour.title, url: window.location.href }).catch(() => {});
    }
  }, [tour.title]);

  const togglePacked = useCallback((i: number) => {
    setPacked(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const price = parseFloat(tour.base_price);
  const priceOld = tour.price_old ? parseFloat(tour.price_old) : null;
  const activity = activityLabel(tour.activity_type);
  const location = locationLabel(tour.location_type);
  const durationLabel = formatDuration(tour);
  const diffBadge = tour.difficulty ? DIFFICULTY_MAP[tour.difficulty] : null;
  const priceLabel = priceUnitLabel(tour.price_unit);
  const seasonLabel = formatSeason(tour.season_start, tour.season_end);
  const rating = tour.rating ? Number(tour.rating) : 0;

  const allPhotos = tour.photos?.length ? tour.photos : (tour.tour_image ? [tour.tour_image] : []);
  const heroImg = allPhotos[0] ?? null;
  const stripPhotos = allPhotos.slice(1);

  const included = Array.isArray(tour.included) ? tour.included : [];
  const notIncluded = Array.isArray(tour.not_included) ? tour.not_included : [];
  const whatToBring = Array.isArray(tour.what_to_bring) ? tour.what_to_bring : [];
  const safetyNotes = Array.isArray(tour.safety_notes) ? tour.safety_notes : [];

  const program = useMemo(() => toProgram(tour.program), [tour.program]);
  const contacts = useMemo(() => toContacts(tour.operator_contacts), [tour.operator_contacts]);
  // Часы звонков (contacts.phone_hours, миграция 840) — строка из БД как есть.
  const phoneHours = useMemo(() => {
    const h = tour.operator_contacts?.phone_hours;
    return typeof h === 'string' ? h.trim().slice(0, 120) : '';
  }, [tour.operator_contacts]);

  // Рыбалка по сезонам (владелец 06.08): виды — те же, что подсвечивает
  // DescriptionWithFishLinks, из единого справочника. Нет упоминаний — нет блока.
  const fishSpecies = useMemo(
    () => detectFishSpecies(
      [tour.title, tour.short_description ?? '', tour.description ?? '',
        ...program.map(s => `${s.title} ${s.text}`)].join(' '),
    ),
    [tour.title, tour.short_description, tour.description, program],
  );

  // Инструментная полоса героя: только подтверждённые данными факты
  // Полоса фактов — ЕДИНСТВЕННОЕ место для сезона, длительности, группы и
  // сложности. Раньше сезон дублировался пилюлей в углу героя, а размер группы —
  // строкой под заголовком: один и тот же факт дважды на одном экране.
  // Значение сложности берём КОРОТКОЕ: под меткой «Сложность» полная форма
  // давала заикание «СЛОЖНОСТЬ · Средняя сложность».
  const instrument: { k: string; v: string }[] = [];
  if (seasonLabel) instrument.push({ k: 'Сезон', v: seasonLabel });
  if (durationLabel) instrument.push({ k: 'Длится', v: durationLabel });
  instrument.push({ k: 'Группа', v: `до ${tour.max_participants}` });
  if (tour.difficulty) {
    const short = difficultyLabel(tour.difficulty, true);
    if (short) instrument.push({ k: 'Сложность', v: short });
  }

  return (
    <div className="pb-24" style={{ background: 'var(--bg-primary)' }}>
      {/* ═══ Кино-герой ═══ */}
      <header className="relative overflow-hidden" style={{ height: 'min(64vh, 560px)', minHeight: 380, background: 'var(--bg-hover)' }}>
        {heroImg ? (
          <button className="absolute inset-0 w-full h-full" onClick={() => setLightbox(0)} aria-label="Открыть фото">
            {/* 1280-вариант: оптимизатор Next выключен (unoptimized), и без
                нарезки герой грузил оригинал — на полевом EDGE десятки секунд. */}
            <Image src={photoSrc(heroImg, 1280)} alt={tour.title} fill priority sizes="100vw" className="object-cover" style={{ filter: 'saturate(1.1) contrast(1.03)' }} />
          </button>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center"><MapPin className="w-16 h-16 text-[var(--text-muted)]" /></div>
        )}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(180deg, rgba(8,11,14,.55) 0%, rgba(8,11,14,0) 26%, rgba(8,11,14,0) 42%, rgba(8,11,14,.82) 100%)' }} />

        {/* Статус дня — живой сигнал безопасности поверх фото (стекло разрешено) */}
        {dayStatus && (
          <div className="absolute top-4 left-4 right-4 flex items-start gap-2 z-[2]">
            <Link
              href="/safety"
              className="inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-white backdrop-blur-md bg-black/40 border border-white/15 transition-colors hover:bg-black/55"
              style={{ fontFamily: FM, minHeight: 44 }}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: dayStatus.hasAlert ? 'var(--warning)' : 'var(--success)' }}
              />
              {/* Подпись именно «в крае»: индикатор отражает обстановку по
                  Камчатке целиком, а не по этому туру. Без такой подписи точка
                  читалась бы как оценка безопасности конкретной поездки. */}
              Обстановка в крае
            </Link>
            {/* Пилюли сезона здесь НЕТ: сезон уже стоит в полосе фактов внизу
                героя. Два одинаковых «Июн — Сен» на одном экране в 300 px друг
                от друга — не акцент, а небрежность. */}
          </div>
        )}

        {/* Заголовок конкретного события здесь НЕ печатаем. /api/public/safety-status
            отдаёт максимальный по краю алерт без привязки к географии тура: на
            карточке сплава по Быстрой всплывало «риск схода оползней с вулкана
            Мутновского» — до этой реки оттуда далеко. Чужое предупреждение на
            карточке тура не просто бесполезно, оно размывает доверие к
            настоящему: релевантные предупреждения даёт SafetyWarnings по
            tourId — ниже по странице, и они действительно про этот тур. */}

        <div className="absolute inset-x-0 bottom-0 pointer-events-none">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-9">
            <nav className="flex items-center gap-2 text-[12px] mb-4" style={{ fontFamily: FM, color: 'rgba(255,255,255,.72)' }}>
              <Link href="/" className="pointer-events-auto hover:text-white">Главная</Link>
              <ChevronRight className="w-3 h-3 opacity-60" />
              <Link href="/catalog" className="pointer-events-auto hover:text-white">Туры</Link>
              <ChevronRight className="w-3 h-3 opacity-60" />
              <Link href={`/marketplace?activity_type=${tour.activity_type}`} className="pointer-events-auto hover:text-white">{activity}</Link>
            </nav>

            <div className="flex items-center gap-2.5 mb-3">
              <span className="w-6 h-0.5 bg-[var(--accent)]" />
              <span className="text-[12px] font-semibold uppercase tracking-[0.2em]" style={{ fontFamily: FM, color: '#fff' }}>{activity}</span>
            </div>

            <h1 className="text-white max-w-[16ch]" style={{ fontFamily: FD, fontWeight: 700, fontSize: 'clamp(30px,5vw,56px)', lineHeight: 1.04, letterSpacing: '-0.02em', textShadow: '0 2px 34px rgba(0,0,0,.4)', textWrap: 'balance' }}>
              {tour.title}
            </h1>

            {/* Самодостаточный ответ в первом экране (SEO-аудит 06.08): AI-поиск
                берёт ~44% цитат из первых 30% страницы, а до этой правки выше
                сгиба стояло только название. Текст — подтверждённое описание
                оператора, из «О туре» он ушёл, чтобы не дублироваться. */}
            {tour.short_description && (
              <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed" style={{ color: 'rgba(255,255,255,.92)', textShadow: '0 1px 18px rgba(0,0,0,.45)' }}>
                {tour.short_description}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 text-sm" style={{ color: 'rgba(255,255,255,.9)' }}>
              {rating > 0 && (
                <span className="flex items-center gap-1.5"><Star className="w-4 h-4 text-[var(--warning)] fill-[var(--warning)]" />{rating.toFixed(1)}{tour.review_count ? <span className="opacity-70">· {tour.review_count}</span> : null}</span>
              )}
              <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4 opacity-80" />{tour.location_name ?? location}</span>
              {/* Размер группы не повторяем: он стоит в полосе фактов ниже
                  («ГРУППА · до 12»). Здесь остаётся только то, чего в полосе
                  нет — рейтинг и место. */}
            </div>

            {instrument.length > 0 && (
              <div className="mt-6 inline-flex flex-wrap rounded-2xl overflow-hidden pointer-events-auto backdrop-blur-md bg-black/40 border border-white/15">
                {instrument.map((c, i) => (
                  <div key={c.k} className="px-4 py-2.5" style={i > 0 ? { boxShadow: 'inset 1px 0 0 rgba(255,255,255,.12)' } : undefined}>
                    <div className="text-[10px] uppercase tracking-[0.14em]" style={{ fontFamily: FM, color: 'rgba(255,255,255,.55)' }}>{c.k}</div>
                    <div className="text-[14px] font-semibold text-white mt-1" style={{ fontFamily: FD }}>{c.v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 sm:px-6">

        {/* ═══ Филмстрип остальных фото ═══ */}
        {stripPhotos.length > 0 && (
          <div className="pt-5 grid grid-cols-4 sm:grid-cols-6 gap-2">
            {stripPhotos.slice(0, 6).map((src, i) => (
              <button key={i} onClick={() => setLightbox(i + 1)} className="relative aspect-square rounded-lg overflow-hidden bg-[var(--bg-hover)] group">
                <Image src={photoSrc(src, 640)} alt={`${tour.title} — фото ${i + 2}`} fill sizes="15vw" loading="lazy" className="object-cover group-hover:scale-105 transition-transform duration-500" />
                {i === 5 && stripPhotos.length > 6 && (
                  <span className="absolute inset-0 bg-black/55 flex items-center justify-center text-white text-sm font-semibold">+{stripPhotos.length - 6}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ═══ Колонки: контент 8/12 · липкая бронь 4/12 ═══ */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 pt-10">

          <div className="lg:col-span-8 space-y-12">

            {/* О туре. short_description отсюда переехал в герой (SEO-аудит
                06.08, цитируемость первого экрана) — здесь остаётся полное
                описание: один и тот же абзац дважды на странице — неопрятность,
                за которую мы уже платили (§11, сторож дублирования). */}
            <section>
              <Eyebrow>О туре</Eyebrow>
              {tour.description && (
                <DescriptionWithFishLinks
                  paragraphs={tour.description.split('\n').filter(p => p.trim())}
                  className="text-[var(--text-secondary)] leading-relaxed space-y-3 text-[15.5px]"
                />
              )}
              <div className="flex flex-wrap gap-2 mt-5">
                {diffBadge && (
                  <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: `color-mix(in srgb, ${diffBadge.color} 14%, transparent)`, color: diffBadge.color }}>{diffBadge.label}</span>
                )}
                {seasonLabel && (
                  <span className="text-xs font-medium px-3 py-1 rounded-full border border-[var(--border)] text-[var(--text-secondary)]"><Calendar className="w-3 h-3 inline mr-1 -mt-0.5" />{seasonLabel}</span>
                )}
                {tour.weather_dependent && (
                  <span className="text-xs font-medium px-3 py-1 rounded-full border border-[var(--warning)]/40 text-[var(--warning)]"><AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />Зависит от погоды</span>
                )}
              </div>
            </section>

            {/* Рыбалка по сезонам — только для туров, где упомянуты виды рыб
                (решение владельца 06.08). Вопросный заголовок — цитируемый
                блок для AI-поиска, продолжение GEO-линии. */}
            {fishSpecies.length > 0 && (
              <section>
                <Eyebrow>Рыбалка по сезонам</Eyebrow>
                <SectionTitle>Когда какая рыба клюёт?</SectionTitle>
                <FishSeasonCalendar species={fishSpecies} />
              </section>
            )}

            {/* Программа дня — только если оператор её прислал */}
            {program.length > 0 && (
              <section>
                <Eyebrow>Как проходит день</Eyebrow>
                <SectionTitle>Программа</SectionTitle>
                <div className="ds-card overflow-hidden p-0">
                  {program.map((step, i) => {
                    const open = openStep === i;
                    return (
                      <div key={`${step.title}-${i}`} className={i > 0 ? 'border-t border-[var(--border)]' : ''}>
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenStep(open ? null : i)}
                          className="relative flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ minHeight: 44 }}
                        >
                          {open && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-[var(--accent)]" />}
                          <span
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold"
                            style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)', fontFamily: FM }}
                          >
                            {i + 1}
                          </span>
                          <span className="flex-1 text-sm font-semibold text-[var(--text-primary)]">{step.title}</span>
                          <ChevronDown
                            className={`w-4 h-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180 text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                            aria-hidden
                          />
                        </button>
                        {open && step.text && (
                          <p className="px-4 pb-4 pl-[64px] text-sm leading-relaxed text-[var(--text-secondary)]">{step.text}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Что включено / не входит */}
            {(included.length > 0 || notIncluded.length > 0) && (
              <section>
                <Eyebrow>Снаряжение и сборы</Eyebrow>
                <SectionTitle>Что включено</SectionTitle>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                  {included.map(item => (
                    <div key={item} className="flex items-start gap-2.5"><CheckCircle2 className="w-5 h-5 text-[var(--success)] shrink-0 mt-0.5" /><span className="text-sm text-[var(--text-primary)]">{item}</span></div>
                  ))}
                  {notIncluded.map(item => (
                    <div key={item} className="flex items-start gap-2.5"><XCircle className="w-5 h-5 text-[var(--text-muted)] shrink-0 mt-0.5" /><span className="text-sm text-[var(--text-muted)]">{item}</span></div>
                  ))}
                </div>
              </section>
            )}

            {/* Что взять — рабочий чек-лист сборов */}
            {whatToBring.length > 0 && (
              <section>
                <SectionTitle icon={Backpack}>Что взять с собой</SectionTitle>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {whatToBring.map((item, i) => {
                    const checked = packed.has(i);
                    return (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={checked}
                        onClick={() => togglePacked(i)}
                        className="flex items-center gap-2.5 rounded-lg border p-3 text-left text-sm transition-all duration-200"
                        style={{
                          minHeight: 44,
                          borderColor: checked ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'var(--border)',
                          background: checked ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--bg-card)',
                        }}
                      >
                        <span
                          className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition-all duration-200"
                          style={{
                            borderColor: checked ? 'var(--accent)' : 'var(--border-strong, var(--border))',
                            background: checked ? 'var(--accent)' : 'transparent',
                          }}
                        >
                          {checked && <Check className="w-3 h-3 text-[var(--bg-card)]" aria-hidden />}
                        </span>
                        <span className={checked ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>{item}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Безопасность — правила от оператора + живые предупреждения платформы */}
            <section>
              <SectionTitle icon={Shield} iconColor="var(--success)">Безопасность</SectionTitle>
              <SafetyWarnings tourId={tour.id} />

              {safetyNotes.length > 0 && (
                <div
                  className="mt-4 rounded-lg border overflow-hidden"
                  style={{ borderColor: 'color-mix(in srgb, var(--danger) 30%, transparent)', background: 'color-mix(in srgb, var(--danger) 7%, transparent)' }}
                >
                  <div className="flex items-center gap-3 p-4 border-b" style={{ borderColor: 'color-mix(in srgb, var(--danger) 20%, transparent)' }}>
                    <span className="grid h-9 w-9 place-items-center rounded-lg shrink-0" style={{ background: 'color-mix(in srgb, var(--danger) 15%, transparent)' }}>
                      <LifeBuoy className="w-5 h-5 text-[var(--danger)]" aria-hidden />
                    </span>
                    <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--text-primary)]" style={{ fontFamily: FM }}>
                      Правила на маршруте
                    </h3>
                  </div>
                  <ul className="p-4 space-y-2">
                    {safetyNotes.map(note => (
                      <li key={note} className="flex items-start gap-2.5 text-sm leading-relaxed text-[var(--text-secondary)]">
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
                        {note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  'Условия и детали подтверждаются оператором до оплаты',
                  'Оператор обычно отвечает в течение 2 часов',
                  'Маршрут проходит через контур безопасности платформы',
                  `Группа: ${tour.min_participants ?? 1}–${tour.max_participants} чел.`,
                ].map(t => (
                  <div key={t} className="flex items-start gap-2.5"><CheckCircle2 className="w-5 h-5 text-[var(--success)] shrink-0 mt-0.5" /><span className="text-sm text-[var(--text-secondary)]">{t}</span></div>
                ))}
              </div>
            </section>

            {/* Точка сбора */}
            {tour.meeting_point && (
              <section>
                <SectionTitle icon={MapPin}>Точка сбора</SectionTitle>
                <div className="ds-card p-5 space-y-2.5">
                  {tour.meeting_point.split('\n').filter(l => l.trim()).map((line, i) => (
                    <div key={i} className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)]">
                      <MapPin className="w-4 h-4 text-[var(--ocean)] shrink-0 mt-0.5" />{line}
                    </div>
                  ))}
                  <p className="text-xs text-[var(--text-muted)] pt-1">Точное время оператор подтверждает после брони.</p>
                </div>
              </section>
            )}

            {/* Оператор — гибрид: бронь через платформу, прямая связь рядом */}
            <section>
              <Eyebrow>Кто проводит</Eyebrow>
              <div className="ds-card p-5">
                <div className="flex items-center gap-4">
                  {/* Логотип партнёра, если он есть в partners.logo_image
                      (804): своё лицо оператора вызывает больше доверия, чем
                      буква в кружке. Нет логотипа — остаётся буква. */}
                  {tour.operator_logo ? (
                    <div className="w-14 h-14 rounded-full overflow-hidden shrink-0 relative bg-[var(--bg-hover)]">
                      <Image
                        src={tour.operator_logo}
                        alt={`Логотип: ${tour.operator_name}`}
                        fill
                        className="object-cover"
                        sizes="56px"
                      />
                    </div>
                  ) : (
                    <div
                      className="w-14 h-14 rounded-full flex items-center justify-center shrink-0 text-white"
                      style={{ background: 'radial-gradient(120% 120% at 30% 20%, var(--accent), color-mix(in srgb, var(--ocean) 55%, #06131a))', fontFamily: FD, fontWeight: 700, fontSize: 20 }}
                    >
                      {tour.operator_name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-[var(--text-primary)]" style={{ fontFamily: FD }}>{tour.operator_name}</p>
                    <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 mt-0.5"><CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />Проводит этот тур сам · проверен платформой</p>
                  </div>
                  <MessageOperatorButton operatorPartnerId={tour.operator_id} tourId={tour.id} tourTitle={tour.title} />
                </div>

                {contacts.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-[var(--border)]">
                    <div className="flex flex-wrap gap-2">
                      {contacts.map(c => (
                        <a
                          key={c.href}
                          href={c.href}
                          {...(c.icon !== 'phone' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                          className="ds-btn ds-btn-secondary text-sm inline-flex items-center gap-2"
                        >
                          {c.icon === 'phone' ? <Phone className="w-4 h-4 text-[var(--ocean)]" /> : c.icon === 'video' ? <Video className="w-4 h-4 text-[var(--ocean)]" /> : c.icon === 'site' ? <Globe className="w-4 h-4 text-[var(--ocean)]" /> : c.icon === 'whatsapp' ? <MessageCircle className="w-4 h-4 text-[var(--success)]" /> : c.icon === 'max' ? <MessageSquare className="w-4 h-4 text-[var(--ocean)]" /> : <Send className="w-4 h-4 text-[var(--ocean)]" />}
                          {c.label}
                        </a>
                      ))}
                    </div>
                    {/* Часы звонков из partners.contacts.phone_hours (840):
                        когда партнёр берёт трубку — факт из БД, не выдумка. */}
                    {phoneHours && (
                      <p className="text-xs text-[var(--text-muted)] mt-2">Звонки: {phoneHours}</p>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Отзывы */}
            <section>
              <SectionTitle icon={Star} iconColor="var(--warning)">
                Отзывы
                {reviews.length > 0 && <span className="text-sm font-normal text-[var(--text-muted)] ml-1" style={{ fontFamily: FM }}>({reviews.length})</span>}
              </SectionTitle>
              {/* Есть отзывы — есть рейтинг (владелец 07.08): сводка над
                  списком из rating/review_count тура, которые пересчитываются
                  из живых отзывов при каждой публикации. */}
              {reviews.length > 0 && rating > 0 && (
                <div className="flex items-center gap-2.5 mb-5">
                  <span className="text-[var(--text-primary)]" style={{ fontFamily: FD, fontWeight: 700, fontSize: 28, letterSpacing: '-0.02em' }}>{rating.toFixed(1)}</span>
                  <div>
                    <Stars rating={Math.round(rating)} />
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{tour.review_count ?? reviews.length} {plural(tour.review_count ?? reviews.length, 'отзыв', 'отзыва', 'отзывов')}</p>
                  </div>
                </div>
              )}
              {reviews.length > 0 ? (
                <div className="space-y-5">
                  {reviews.map(r => (
                    <div key={r.id} className="pb-5 border-b border-[var(--border)] last:border-0 last:pb-0">
                      <div className="flex items-start justify-between gap-4 mb-2">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-[var(--accent)]/15 flex items-center justify-center shrink-0"><span className="text-sm font-bold text-[var(--accent)]">{r.author_name.charAt(0)}</span></div>
                          <div>
                            <p className="text-sm font-medium text-[var(--text-primary)]">{r.author_name}</p>
                            {r.author_city && <p className="text-xs text-[var(--text-muted)]">{r.author_city}</p>}
                          </div>
                        </div>
                        <div className="text-right shrink-0"><Stars rating={r.rating} />{r.trip_date && <p className="text-xs text-[var(--text-muted)] mt-1">{r.trip_date}</p>}</div>
                      </div>
                      <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{r.comment}</p>
                      {(r.photos?.length ?? 0) > 0 && (
                        <div className="flex gap-2 mt-3">
                          {r.photos!.slice(0, 3).map((url) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              key={url}
                              src={url}
                              alt={`Фото из отзыва ${r.author_name}`}
                              loading="lazy"
                              className="w-20 h-20 rounded-lg object-cover bg-[var(--bg-hover)]"
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {/* Форма доступна и при существующих отзывах — раньше она
                      рендерилась только в пустом состоянии, и второй отзыв
                      оставить было неоткуда. */}
                  <div className="text-center">
                    <TourReviewForm tourId={tour.id} />
                  </div>
                </div>
              ) : (
                <div className="text-center py-10 px-6 border border-dashed border-[var(--border)] rounded-lg">
                  <MessageSquare className="w-7 h-7 mx-auto mb-2.5 text-[var(--text-muted)]" />
                  <p className="text-[var(--text-secondary)] text-sm">Пока никто не оставил отзыв.<br />Будьте первым, кто расскажет о поездке.</p>
                  {/* Была нарисованная кнопка: <span> без обработчика и без
                      ссылки. Выглядела как действие и не делала ничего —
                      владелец так и написал, «не работает». */}
                  <TourReviewForm tourId={tour.id} />
                </div>
              )}
            </section>

            {/* Кузьмич */}
            <Link href={`/planner?hint=${encodeURIComponent(tour.activity_type)}`} className="flex items-center gap-4 p-5 rounded-lg border border-[var(--ocean)]/25 bg-[var(--ocean)]/5 hover:bg-[var(--ocean)]/10 transition-colors">
              <div className="w-11 h-11 rounded-full bg-[var(--ocean)] flex items-center justify-center shrink-0 text-white" style={{ fontFamily: FD, fontWeight: 700 }}>К</div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-[var(--text-primary)] text-sm">Спросить Кузьмича</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">Подходит ли детям, что с погодой в вашу дату, как одеться — Кузьмич знает Камчатку.</p>
              </div>
              <ChevronRight className="w-4 h-4 text-[var(--ocean)] shrink-0" />
            </Link>
          </div>

          {/* ─── Липкая бронь ─── */}
          <aside className="lg:col-span-4">
            <div className="lg:sticky lg:top-20 space-y-4">
              <div className="ds-card p-6">
                <div className="flex items-baseline gap-2 mb-1">
                  {priceOld && priceOld > price && <span className="text-base text-[var(--text-muted)] line-through">{formatPrice(priceOld)}</span>}
                  <span className="text-[var(--accent)]" style={{ fontFamily: FD, fontWeight: 700, fontSize: 30, letterSpacing: '-0.02em' }}>{formatPrice(price)}</span>
                </div>
                <p className="text-sm text-[var(--text-muted)] mb-5">{priceLabel}</p>

                <div id="booking">
                  <BookingFormClient tourId={tour.id} basePrice={price} maxParticipants={tour.max_participants} tourTitle={tour.title} />
                </div>

                <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-hover)] p-3 flex items-start gap-2">
                  <Shield className="w-4 h-4 text-[var(--success)] shrink-0 mt-0.5" />
                  <p className="text-xs leading-relaxed text-[var(--text-secondary)]">Оплата — только после того, как оператор подтвердит детали, погоду и даты. Без скрытых комиссий.</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={handleShare} className="flex-1 ds-card flex items-center justify-center gap-2 py-2.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer" style={{ minHeight: 44 }}>
                  <Share2 className="w-4 h-4" /> Поделиться
                </button>
                <button onClick={handleWishlist} disabled={wishlistLoading} className="flex-1 ds-card flex items-center justify-center gap-2 py-2.5 text-sm transition-colors cursor-pointer disabled:opacity-50" style={{ minHeight: 44, ...(wishlisted ? { color: 'var(--danger)' } : { color: 'var(--text-secondary)' }) }}>
                  <Heart className={`w-4 h-4 ${wishlisted ? 'fill-current' : ''}`} />{wishlisted ? 'В избранном' : 'В избранное'}
                </button>
              </div>
              {wishlistError && (
                <p className="mt-2 text-xs text-[var(--danger)] text-center">{wishlistError}</p>
              )}
            </div>
          </aside>
        </div>

        {/* Партнёрских блоков здесь НЕТ (решение владельца 04.08). Агрегаторы
            билетов и отелей выводили под карточкой рекламный дисклеймер с ИНН
            посторонних юрлиц — на странице тура НАШЕГО проверенного оператора
            это выглядит как подмена продавца и бьёт по доверию. Карточка тура
            продаёт тур оператора, а не чужие сервисы. */}
      </div>

      {lightbox !== null && allPhotos.length > 0 && (
        <Lightbox images={allPhotos} alt={tour.title} startIdx={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
