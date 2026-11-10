'use client';

export const dynamic = 'force-dynamic';

import { useState, useRef, useEffect, useCallback } from 'react';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { useRouter } from 'next/navigation';
import { MapPin, Calendar, Users, Phone, Mail, Shield, AlertTriangle, Download, ArrowLeft, Plus, Trash2, CheckCircle, Loader2, Search, ChevronDown } from 'lucide-react';
import { MCHS_ONLINE_FORM_URL, MCHS_DEADLINE_SHORT } from '@/lib/safety/mchs-registration';
import { mchsFormText } from '@/lib/safety/mchs-form-text';
import { submitTripWatchForm, TELEGRAM_CHAT_ID } from '@/lib/safety/register-submit';
import TripWatchReturnBox from '@/components/safety/TripWatchReturnBox';
import MchsConsultPhones from '@/components/safety/MchsConsultPhones';
import ParkPermitAction from '@/components/safety/ParkPermitAction';

interface RouteOption {
  id: string;
  title: string;
  distance_km: string | null;
  difficulty_level: string | null;
  zone: string | null;
  waypoint_names: string[] | null;
}

type Step = 1 | 2 | 3 | 4;

interface GroupMember {
  name: string;
  phone: string;
  birth_year: string;
}

export default function RegisterRoutePage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Лист с данными группы скачался? null — ещё не пробовали. Экран не говорит
  // «скачан», если сервер листа не отдал.
  const [pdfSaved, setPdfSaved] = useState<boolean | null>(null);
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [watchLinkCopied, setWatchLinkCopied] = useState(false);
  const [mchsTextCopied, setMchsTextCopied] = useState<'yes' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Шаг 1: Маршрут
  const [routeName, setRouteName] = useState('');
  const [routeDescription, setRouteDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [region, setRegion] = useState('Камчатский край');
  const [expectedReturnTime, setExpectedReturnTime] = useState('');

  const isDay = startDate && endDate && startDate === endDate;

  // Поиск маршрута из БД
  const [routeQuery, setRouteQuery] = useState('');
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [routeSearching, setRouteSearching] = useState(false);
  const [routeDropdownOpen, setRouteDropdownOpen] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const searchRoutes = useCallback(async (q: string) => {
    if (q.length < 2) { setRouteOptions([]); return; }
    setRouteSearching(true);
    try {
      const res = await fetch(`/api/routes/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json() as { routes: RouteOption[] };
        setRouteOptions(data.routes);
        setRouteDropdownOpen(data.routes.length > 0);
      }
    } finally {
      setRouteSearching(false);
    }
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { void searchRoutes(routeQuery); }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [routeQuery, searchRoutes]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setRouteDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectRoute = (route: RouteOption) => {
    setSelectedRouteId(route.id);
    setRouteName(route.title);
    const waypoints = route.waypoint_names?.length
      ? route.waypoint_names.join(' → ')
      : '';
    setRouteDescription(waypoints);
    setRouteQuery(route.title);
    setRouteDropdownOpen(false);
  };

  // Предзаполнение из query (C-7): план /trip/[token] приводит сюда с готовым
  // маршрутом и датами — турист не перенабирает их руками. Только шаг 1 и
  // никаких ПД: имена и телефоны группы человек вводит сам. Query читается из
  // window.location — тот же приём, что у формы брони (?date=, B-3), без
  // хука параметров и Suspense-обвязки. Битое значение просто пропускается.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const name = (q.get('name') ?? '').trim().slice(0, 200);
    const desc = (q.get('desc') ?? '').trim().slice(0, 2000);
    const start = q.get('start') ?? '';
    const end = q.get('end') ?? '';
    // Только routeName: routeQuery — поле поиска по базе маршрутов, его
    // предзаполнение дёрнуло бы поиск и открыло дропдаун поверх формы.
    if (name) setRouteName(name);
    if (desc) setRouteDescription(desc);
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) setStartDate(start);
    if (/^\d{4}-\d{2}-\d{2}$/.test(end)) setEndDate(end);
  }, []);

  // Шаг 2: Группа
  const [groupSize, setGroupSize] = useState(1);
  const [members, setMembers] = useState<GroupMember[]>([{ name: '', phone: '', birth_year: '' }]);

  // Шаг 3: Руководитель + экстренный контакт
  const [leaderName, setLeaderName] = useState('');
  const [leaderPhone, setLeaderPhone] = useState('');
  const [leaderEmail, setLeaderEmail] = useState('');
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [emergencyRelation, setEmergencyRelation] = useState('');
  const [emergencyTelegram, setEmergencyTelegram] = useState('');
  const [emergencyEmail, setEmergencyEmail] = useState('');
  const [contactConsent, setContactConsent] = useState(false);

  // Экстренный контакт из профиля туриста (/hub/tourist/profile): заполнен там —
  // подставляется сюда, если человек вошёл и поле ещё пустое. Не вошёл или
  // профиля нет — форма как была, всё вводится руками.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/tourist/profile', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: { profile?: Record<string, string | null> } } | null) => {
        const pr = j?.data?.profile;
        if (cancelled || !pr) return;
        const name = (pr.emergency_contact_name ?? '').trim();
        const phone = (pr.emergency_contact_phone ?? '').trim();
        const relation = (pr.emergency_contact_relation ?? '').trim();
        if (name) setEmergencyName((v) => v || name);
        if (phone) setEmergencyPhone((v) => v || phone);
        if (relation) setEmergencyRelation((v) => v || relation);
      })
      .catch((err) => logSwallowedFailure('register', 'экстренный контакт из профиля', err));
    return () => { cancelled = true; };
  }, []);

  // Шаг 4: Disclaimer
  const [accepted, setAccepted] = useState(false);

  const canNext1 =
    routeName.trim() &&
    startDate &&
    endDate &&
    new Date(endDate) >= new Date(startDate) &&
    (!isDay || expectedReturnTime.length > 0);
  const canNext2 = groupSize >= 1 && groupSize <= 30;
  // chat_id Telegram — число. Имя с «@» сервер не примет, и узнать об этом надо
  // здесь, а не по отказу после кнопки.
  const telegramOk = TELEGRAM_CHAT_ID.test(emergencyTelegram.trim());
  const canNext3 = leaderName.trim() && leaderPhone.trim() && emergencyName.trim() && emergencyPhone.trim() && telegramOk;
  const canSubmit = canNext1 && canNext2 && canNext3 && accepted && contactConsent;

  const addMember = () => {
    if (members.length < groupSize) {
      setMembers([...members, { name: '', phone: '', birth_year: '' }]);
    }
  };

  const removeMember = (idx: number) => {
    setMembers(members.filter((_, i) => i !== idx));
  };

  const updateMember = (idx: number, field: keyof GroupMember, value: string) => {
    const updated = [...members];
    updated[idx] = { ...updated[idx], [field]: value };
    setMembers(updated);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const payload = {
        route_name: routeName.trim(),
        route_description: routeDescription.trim() || undefined,
        start_date: startDate,
        end_date: endDate,
        expected_return_time: expectedReturnTime || undefined,
        region,
        group_size: groupSize,
        group_members: members.filter(m => m.name.trim()).map(m => ({
          name: m.name.trim(),
          phone: m.phone.trim() || undefined,
          birth_year: m.birth_year ? parseInt(m.birth_year) : undefined,
        })),
        leader_name: leaderName.trim(),
        leader_phone: leaderPhone.trim(),
        leader_email: leaderEmail.trim() || undefined,
        emergency_contact_name: emergencyName.trim(),
        emergency_contact_phone: emergencyPhone.trim(),
        emergency_contact_relation: emergencyRelation.trim() || undefined,
        emergency_contact_telegram_chat_id: emergencyTelegram.trim() || undefined,
        emergency_contact_email: emergencyEmail.trim() || undefined,
        emergency_contact_consent: contactConsent,
        accepted_disclaimer: true as const,
      };

      // Контроль включает первый запрос; лист — второй, и он ничего не
      // записывает. Отказ листа уже включённый контроль не отменяет: экран
      // успеха со ссылкой «Я вернулся» показывается всегда, когда запись есть
      // (lib/safety/register-submit; docs/safety/MCHS_PLAN.md, С1).
      const result = await submitTripWatchForm(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRegistrationId(result.registrationId);
      if (result.sheet) {
        const url = URL.createObjectURL(result.sheet);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vedar-mchs-dannye-${result.registrationId.slice(0, 8)}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        setPdfSaved(true);
      } else {
        setPdfSaved(false);
      }
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <CheckCircle className="w-16 h-16 text-[var(--success)] mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Контроль возвращения включён</h1>
          <p className="text-[var(--text-secondary)] mb-6 text-sm">
            Это не регистрация в МЧС: заявку подаёте вы, Ведар её не отправляет и ответа МЧС не видит.{' '}
            {pdfSaved === false
              ? 'Лист с данными группы не скачался — те же данные можно скопировать ниже.'
              : 'Лист с данными группы отдан на скачивание — это не бланк МЧС, а ваши данные для заявки. Не нашли файл — те же данные можно скопировать ниже.'}{' '}
            Способы подачи — ниже.
          </p>

          {registrationId && (
            <TripWatchReturnBox registrationId={registrationId} endDate={endDate} expectedReturnTime={expectedReturnTime} />
          )}

          {/* Страница для экстренного контакта (/watch) — до выхода, а не в
              момент тревоги (WATCH_MANIFEST, правило 7: контакт знает, что он
              контакт). Номер руководителя он спросит у вас — это и есть ключ. */}
          {registrationId && (
            <div className="p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] mb-6 text-left">
              <p className="font-semibold text-sm mb-1">Ссылка для экстренного контакта</p>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Перешлите её {emergencyName.trim() || 'контакту'} до выхода. По ней видно, отметились ли вы и
                где были последний раз, пока контроль открыт. Для входа нужен номер руководителя группы.
              </p>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(`${window.location.origin}/watch?id=${registrationId}`)
                    .then(() => setWatchLinkCopied(true))
                    .catch(() => {});
                }}
                className="w-full py-2.5 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--bg-hover)]"
              >
                {watchLinkCopied ? 'Скопировано' : 'Скопировать ссылку для контакта'}
              </button>
            </div>
          )}

          {/* Срок — первым, до способов подачи. Способ бесполезен, если о
              сроке узнали накануне выхода: заявка подаётся за 10 РАБОЧИХ дней. */}
          <div className="mb-4 p-3 rounded-lg text-left"
            style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
            <p className="text-sm font-semibold text-[var(--text-primary)]">{MCHS_DEADLINE_SHORT}</p>
          </div>

          <div className="space-y-3 mb-6 text-left">
            <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
              <p className="font-semibold text-sm mb-1">Онлайн — сайт МЧС России</p>
              <p className="text-xs text-[var(--text-muted)]">Электронная заявка на регистрацию туристской группы.</p>
              <a href={MCHS_ONLINE_FORM_URL} target="_blank" rel="noopener noreferrer"
                 className="text-[var(--accent)] text-xs font-medium mt-2 inline-block hover:underline">
                Открыть форму МЧС →
              </a>
              {/* Данные регистрации одним текстом — переносить в онлайн-форму,
                  а не перепечатывать (тот же текст, что у оператора,
                  lib/safety/mchs-form-text). Отправляет турист сам. */}
              <button
                type="button"
                onClick={() => {
                  const text = mchsFormText({
                    route: routeName,
                    startDate,
                    endDate,
                    leaderRole: 'self',
                    guideContacts: leaderName.trim() ? { name: leaderName, phone: leaderPhone } : null,
                    groupComposition: members
                      .filter(m => m.name.trim())
                      .map(m => ({ fullName: m.name, phone: m.phone, birthDate: m.birth_year })),
                    emergencyContacts: emergencyName.trim()
                      ? [{ name: emergencyName, phone: emergencyPhone, relation: emergencyRelation }]
                      : [],
                  });
                  navigator.clipboard?.writeText(text)
                    .then(() => setMchsTextCopied('yes'))
                    .catch(() => setMchsTextCopied('failed'));
                }}
                className="block mt-2 text-xs font-medium text-[var(--accent)] hover:underline"
              >
                {mchsTextCopied === 'yes' ? 'Текст для формы скопирован' : 'Скопировать данные для формы'}
              </button>
              {mchsTextCopied === 'failed' && (
                <p className="text-xs text-[var(--warning)] mt-1">
                  {pdfSaved === false
                    ? 'Браузер не дал скопировать, и лист не скачался — перепишите данные вручную.'
                    : 'Браузер не дал скопировать — данные есть в скачанном листе.'}
                </p>
              )}
            </div>
            <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
              <p className="font-semibold text-sm mb-1">Почтой (заказное с уведомлением)</p>
              <p className="text-xs text-[var(--text-muted)]">683003, Камчатский край, г. Петропавловск-Камчатский, ул. Ленинградская, д. 25</p>
            </div>
            <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)]">
              <p className="font-semibold text-sm mb-1">Лично — ЦУКС ГУ МЧС по Камчатскому краю</p>
              <p className="text-xs text-[var(--text-muted)]">г. Петропавловск-Камчатский, ул. Тундровая, д. 6</p>
            </div>
            <MchsConsultPhones />
          </div>

          {/* Разрешение парка — вторая, ОТДЕЛЬНАЯ обязанность (lib/safety/park-permit).
              Владелец 25.09: «где зелёная кнопка регистрации?» — её не было
              там, где человек регистрируется. */}
          <div className="mb-6 text-left">
            <ParkPermitAction />
          </div>

          <button
            onClick={() => router.push('/map')}
            className="w-full py-3 rounded-lg bg-[var(--accent)] text-[var(--text-primary)] font-semibold text-sm hover:opacity-90"
          >
            Вернуться к карте
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Шапка */}
      <div className="sticky top-0 z-50 bg-[var(--bg-primary)] border-b border-[var(--border)]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => step > 1 ? setStep((step - 1) as Step) : router.back()}
                  className="p-1 rounded-lg hover:bg-[var(--bg-hover)]">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-bold text-sm">Контроль возвращения и данные для МЧС</h1>
            <p className="text-[10px] text-[var(--text-muted)]">Шаг {step} из 4</p>
          </div>
          {/* Прогресс */}
          <div className="flex gap-1">
            {[1, 2, 3, 4].map(s => (
              <div key={s} className={`w-6 h-1 rounded-full transition-colors ${
                s <= step ? 'bg-[var(--accent)]' : 'bg-[var(--bg-hover)]'
              }`} />
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Адрес /register читается как «регистрация аккаунта», а это заявка
            маршрута в МЧС; турист, искавший вход, попадал сюда (#1780).
            Говорим прямо и даём дорогу к аккаунту одним касанием. */}
        {step === 1 && (
          <p className="mb-5 text-xs text-[var(--text-secondary)] leading-relaxed">
            Здесь включают контроль возвращения и собирают данные, чтобы заявить{' '}
            <span className="font-semibold text-[var(--text-primary)]">маршрут в МЧС</span>. Заявку в МЧС
            подаёте вы сами. Нужен аккаунт на платформе?{' '}
            <a href="/auth/login?mode=register" className="text-[var(--ocean)] underline underline-offset-2">
              Регистрация аккаунта — на странице входа
            </a>.
          </p>
        )}
        {step === 1 && (
          <div className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-xs text-[var(--text-secondary)]">
            <p>Идёте в природный парк — нужно ещё <span className="font-semibold text-[var(--text-primary)]">разрешение парка</span>, это отдельно от МЧС:</p>
            <ParkPermitAction variant="compact" />
          </div>
        )}
        {/* Шаг 1: Маршрут */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <MapPin className="w-5 h-5 text-[var(--accent)]" />
              Маршрут
            </h2>

            {/* Поиск маршрута из базы */}
            <div ref={dropdownRef} className="relative">
              <label className="text-xs text-[var(--text-muted)] mb-1 block">Найти маршрут из базы (необязательно)</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] pointer-events-none" />
                {routeSearching && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)] animate-spin" />
                )}
                <input
                  type="text"
                  value={routeQuery}
                  onChange={e => {
                    setRouteQuery(e.target.value);
                    setSelectedRouteId(null);
                  }}
                  onFocus={() => { if (routeOptions.length > 0) setRouteDropdownOpen(true); }}
                  placeholder="Авачинский, Налычево, Мутновский..."
                  className="w-full pl-9 pr-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none transition-colors"
                />
              </div>
              {routeDropdownOpen && routeOptions.length > 0 && (
                <div className="absolute z-50 left-0 right-0 mt-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow-lg overflow-hidden max-h-60 overflow-y-auto">
                  {routeOptions.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      onMouseDown={() => selectRoute(r)}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--bg-hover)] border-b border-[var(--border)] last:border-0 transition-colors"
                    >
                      <p className="text-sm font-medium text-[var(--text-primary)]">{r.title}</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        {[r.zone, r.distance_km ? `${r.distance_km} км` : null, r.difficulty_level].filter(Boolean).join(' · ')}
                        {r.waypoint_names?.length ? ` · ${r.waypoint_names.slice(0, 3).join(' → ')}${r.waypoint_names.length > 3 ? '...' : ''}` : ''}
                      </p>
                    </button>
                  ))}
                </div>
              )}
              {selectedRouteId && (
                <p className="text-xs text-[var(--success)] mt-1 flex items-center gap-1">
                  <CheckCircle className="w-3 h-3" />
                  Маршрут выбран — название и точки заполнены
                </p>
              )}
            </div>

            <div>
              <label className="text-xs text-[var(--text-muted)] mb-1 block">Название маршрута *</label>
              <input
                type="text"
                value={routeName}
                onChange={e => { setRouteName(e.target.value); setSelectedRouteId(null); }}
                placeholder="Авачинский перевал"
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label className="text-xs text-[var(--text-muted)] mb-1 block">Точки маршрута (необязательно)</label>
              <textarea
                value={routeDescription}
                onChange={e => setRouteDescription(e.target.value)}
                placeholder="Пиначево → Таловский кордон → Авачинский перевал"
                rows={3}
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none transition-colors resize-none"
              />
            </div>

            <div>
              <label htmlFor="reg-region" className="text-xs text-[var(--text-muted)] mb-1 block">Регион</label>
              <input
                id="reg-region"
                type="text"
                value={region}
                onChange={e => setRegion(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none transition-colors"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="reg-start" className="text-xs text-[var(--text-muted)] mb-1 block">Дата выхода *</label>
                <input
                  id="reg-start"
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label htmlFor="reg-end" className="text-xs text-[var(--text-muted)] mb-1 block">Дата возврата *</label>
                <input
                  id="reg-end"
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  min={startDate}
                  className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none transition-colors"
                />
              </div>
            </div>

            <div>
              <label htmlFor="reg-return-time" className="text-xs text-[var(--text-muted)] mb-1 block">
                Контрольное время возврата {isDay ? '*' : '(необязательно)'}
              </label>
              <input
                id="reg-return-time"
                type="time"
                value={expectedReturnTime}
                onChange={e => setExpectedReturnTime(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none transition-colors"
              />
              <p className="text-[11px] text-[var(--text-muted)] mt-1">
                {isDay
                  ? 'Во сколько ожидается возвращение. Сторож предупредит экстренный контакт если не вернётесь вовремя.'
                  : 'Во сколько ожидается возвращение в день окончания. Если не задать — сторож срабатывает с 20:00.'}
              </p>
            </div>

            <button
              onClick={() => setStep(2)}
              disabled={!canNext1}
              className="w-full py-3 rounded-lg bg-[var(--accent)] text-[var(--text-primary)] font-semibold text-sm
                disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              Далее
            </button>
          </div>
        )}

        {/* Шаг 2: Группа */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Users className="w-5 h-5 text-[var(--accent)]" />
              Группа
            </h2>

            <div>
              <label className="text-xs text-[var(--text-muted)] mb-1 block">Количество человек (1-30) *</label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const newSize = Math.max(1, groupSize - 1);
                    setGroupSize(newSize);
                    if (members.length > newSize) setMembers(members.slice(0, newSize));
                  }}
                  className="w-12 h-12 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-xl font-bold
                    hover:bg-[var(--bg-hover)] transition-colors"
                >
                  −
                </button>
                <span className="text-3xl font-bold flex-1 text-center">{groupSize}</span>
                <button
                  onClick={() => {
                    const newSize = Math.min(30, groupSize + 1);
                    setGroupSize(newSize);
                    if (members.length < newSize) addMember();
                  }}
                  className="w-12 h-12 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-xl font-bold
                    hover:bg-[var(--bg-hover)] transition-colors"
                >
                  +
                </button>
              </div>
            </div>

            {/* Участники */}
            <p className="text-xs text-[var(--text-muted)]">Участники (необязательно, но полезно для МЧС)</p>
            {members.map((m, idx) => (
              <div key={idx} className="p-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-muted)] w-5">#{idx + 1}</span>
                  {members.length > 1 && (
                    <button type="button" onClick={() => removeMember(idx)} aria-label={`Убрать участника ${idx + 1}`} className="ml-auto p-1 text-[var(--text-muted)] hover:text-red-400">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={m.name}
                  onChange={e => updateMember(idx, 'name', e.target.value)}
                  placeholder="ФИО"
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="tel"
                    value={m.phone}
                    onChange={e => updateMember(idx, 'phone', e.target.value)}
                    placeholder="Телефон"
                    className="w-full px-3 py-2 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                      focus:border-[var(--accent)] focus:outline-none"
                  />
                  <input
                    type="number"
                    value={m.birth_year}
                    onChange={e => updateMember(idx, 'birth_year', e.target.value)}
                    placeholder="Год рождения"
                    className="w-full px-3 py-2 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                      focus:border-[var(--accent)] focus:outline-none"
                  />
                </div>
              </div>
            ))}

            <div className="flex gap-3">
              <button
                onClick={() => setStep(1)}
                className="flex-1 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] font-semibold text-sm
                  hover:bg-[var(--bg-hover)] transition-colors"
              >
                Назад
              </button>
              <button
                onClick={() => setStep(3)}
                className="flex-[2] py-3 rounded-lg bg-[var(--accent)] text-[var(--text-primary)] font-semibold text-sm
                  hover:opacity-90 transition-opacity"
              >
                Далее
              </button>
            </div>
          </div>
        )}

        {/* Шаг 3: Руководитель + экстренный контакт */}
        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Phone className="w-5 h-5 text-[var(--accent)]" />
              Контакты
            </h2>

            <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] space-y-3">
              <p className="text-xs text-[var(--accent)] font-semibold uppercase tracking-wider">Руководитель группы</p>
              <input
                type="text"
                value={leaderName}
                onChange={e => setLeaderName(e.target.value)}
                placeholder="ФИО *"
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="tel"
                  value={leaderPhone}
                  onChange={e => setLeaderPhone(e.target.value)}
                  placeholder="Телефон *"
                  className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  type="email"
                  value={leaderEmail}
                  onChange={e => setLeaderEmail(e.target.value)}
                  placeholder="Email"
                  className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
            </div>

            <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] space-y-3">
              <p className="text-xs text-red-400 font-semibold uppercase tracking-wider">
                Экстренный контакт <span className="text-[var(--text-muted)]">(получит уведомление если не вернулись)</span>
              </p>
              <input
                type="text"
                value={emergencyName}
                onChange={e => setEmergencyName(e.target.value)}
                placeholder="ФИО *"
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="tel"
                  value={emergencyPhone}
                  onChange={e => setEmergencyPhone(e.target.value)}
                  placeholder="Телефон *"
                  className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none"
                />
                <input
                  type="text"
                  value={emergencyRelation}
                  onChange={e => setEmergencyRelation(e.target.value)}
                  placeholder="Кем приходится"
                  className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                    focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <input
                type="text"
                inputMode="numeric"
                value={emergencyTelegram}
                onChange={e => setEmergencyTelegram(e.target.value)}
                placeholder="Telegram chat_id (необязательно)"
                aria-invalid={!telegramOk}
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none"
              />
              <p className={`text-[10px] ${telegramOk ? 'text-[var(--text-muted)]' : 'text-[var(--danger)]'}`}>
                {telegramOk
                  ? 'Для Telegram-уведомлений. Это число, не имя: узнать можно через @userinfobot'
                  : 'Только цифры: это число, а не имя с «@». Не знаете его — оставьте поле пустым.'}
              </p>
              <input
                type="email"
                value={emergencyEmail}
                onChange={e => setEmergencyEmail(e.target.value)}
                placeholder="Email (необязательно)"
                className="w-full px-4 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] text-sm
                  focus:border-[var(--accent)] focus:outline-none"
              />
              <label className="flex items-start gap-3 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={contactConsent}
                  onChange={e => setContactConsent(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--text-secondary)]">
                  Контакт <strong>{emergencyName || '___'}</strong> согласен получать уведомления
                  от Ведар о статусе маршрута (Telegram / Email).
                </span>
              </label>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep(2)}
                className="flex-1 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] font-semibold text-sm
                  hover:bg-[var(--bg-hover)] transition-colors"
              >
                Назад
              </button>
              <button
                onClick={() => setStep(4)}
                disabled={!canNext3}
                className="flex-[2] py-3 rounded-lg bg-[var(--accent)] text-[var(--text-primary)] font-semibold text-sm
                  disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              >
                Далее
              </button>
            </div>
          </div>
        )}

        {/* Шаг 4: Disclaimer + отправка */}
        {step === 4 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Shield className="w-5 h-5 text-[var(--accent)]" />
              Подтверждение
            </h2>

            {/* Сводка */}
            <div className="p-4 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] space-y-2 text-sm">
              <p><span className="text-[var(--text-muted)]">Маршрут:</span> {routeName}</p>
              <p><span className="text-[var(--text-muted)]">Даты:</span> {startDate} — {endDate}{expectedReturnTime ? `, возврат в ${expectedReturnTime}` : ''}</p>
              <p><span className="text-[var(--text-muted)]">Группа:</span> {groupSize} чел.</p>
              <p><span className="text-[var(--text-muted)]">Руководитель:</span> {leaderName}</p>
              <p><span className="text-[var(--text-muted)]">Экстренный контакт:</span> {emergencyName} ({emergencyPhone})</p>
            </div>

            {/* Disclaimer */}
            <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-yellow-400 mb-1">Важно</p>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    Ведар включает <strong>контроль возвращения</strong> и собирает данные группы
                    для заявки. Это <strong>не регистрация в МЧС</strong>: заявку подаёте вы —
                    на сайте МЧС России, заказным письмом или лично в ЦУКС ГУ МЧС России
                    по Камчатскому краю. Адреса покажем после сохранения.
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-2">
                    Ведар не гарантирует получение уведомления экстренным контактом
                    и не несёт ответственности за реакцию третьих лиц.
                  </p>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={e => setAccepted(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded accent-[var(--accent)]"
                />
                <span className="text-xs text-[var(--text-secondary)]">
                  Я понимаю что это <strong>не официальная регистрация</strong> и
                 Ведар <strong>не является службой спасения</strong>.
                  Я самостоятельно подам заявку в МЧС.
                </span>
              </label>
            </div>

            {error && (
              <p className="text-sm text-red-400 text-center">{error}</p>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep(3)}
                className="flex-1 py-3 rounded-lg bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-primary)] font-semibold text-sm
                  hover:bg-[var(--bg-hover)] transition-colors"
              >
                Назад
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="flex-[2] py-3 rounded-lg bg-[var(--accent)] text-[var(--text-primary)] font-semibold text-sm
                  disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity
                  flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Сохраняю...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    Включить контроль и скачать лист
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        <div className="h-8" />
      </div>
    </div>
  );
}
// rebuild trigger Mon Apr 27 22:22:34 UTC 2026
