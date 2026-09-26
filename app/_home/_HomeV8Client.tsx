'use client';

/**
 * Главная v8 «Воронка» — фото-первый герой + честные приборы (мобильная главная).
 * Отличия от v7-прототипа (по договорённости с владельцем):
 *   - Герой на реальном фото Камчатки, не на градиенте-заглушке.
 *   - Блок безопасности — реальные данные: KVERT ACC (volcano_status) +
 *     лента external_alerts. Фейковой сейсмоленты и компаса нет.
 *   - Платы — реальные туры/маршруты с фото и ценой (queryCatalog).
 *   - Лид-форма шлёт реальный POST /api/leads (lead-processor).
 *   - SOS окрашен в --danger, отдельно от коммерческой оранжевой.
 *   - Эко-баллы не показываем: начисление в коде не подключено (нечестно).
 * Данные приходят из серверного data-слоя (app/_home/data.ts).
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { Flame, Snowflake, Waves, Droplets, Trees, Sun, Moon, Phone, X, ChevronDown, MapPin, User, Mountain, Footprints, CalendarDays, Navigation, Radar, ClipboardCheck, LifeBuoy, Compass, Camera, Fish, Map as MapIcon, CalendarX, type LucideIcon } from 'lucide-react';
import BottomNav from '@/components/shared/BottomNav';

// P0-3b: реализации радара/ленты/пульса переехали в components/safety/LiveStatus.
// Реэкспорт — обратная совместимость импортов (home-alerts-ticker.test.ts и
// любые внешние потребители формул подписи).
export { alertStamp, clip } from '@/components/safety/LiveStatus';
// Те же подписи и та же обрезка, что в ленте на /safety: две поверхности об
// одном предупреждении обязаны говорить одинаково.
import { alertStamp as stampAlert } from '@/components/safety/LiveStatus';
import { alertBody } from '@/lib/home/alert-body';
import { radarAlertsLine, radarVolcanoLine, alertsCountLabel } from '@/lib/home/radar-summary';
import type { HomeV8Data, SafetyAlert } from './data';
import { EMERGENCY_NUMBERS } from '@/lib/safety/emergency-numbers';
import { INTENT_CHIPS } from '@/lib/home/intent-chips';
import { safetyPill } from '@/lib/home/safety-pill';
import { photoSrc } from '@/lib/images/variant';
import {
  dataFreshness, freshnessDot, freshnessShort, geometryCoverage, coverageDot, coverageShort, plural,
} from '@/lib/home/data-freshness';
import { plateFacts } from '@/lib/home/plate-facts';
import { AVAILABILITY_LABEL } from '@/lib/tours/catalog-availability';
import EmergencyAction from '@/components/shared/EmergencyAction';
import { ShareButton } from '@/components/shared/ShareButton';
import { PdConsentCheckbox } from '@/components/legal/PdConsentCheckbox';
import { THEME_STORAGE_KEY, readDomTheme } from '@/lib/theme';

const ELEMENT_ICON: Record<string, LucideIcon> = {
  fire: Flame, snow: Snowflake, ocean: Waves, therm: Droplets, nature: Trees,
};

const CHIPS = ['Вулканы', 'Рыбалка', 'Медведи', 'Океан', 'Термы', 'Хели-ски'];

// Иконки чипов быстрого подбора — по стабильному ключу, не по подписи.
const CHIP_ICON: Record<string, LucideIcon> = {
  volcano: Mountain, thermal: Droplets, easy: Footprints, days: CalendarDays, fishing: Fish,
};

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «6–9 августа» из ISO-дат поездки. Обе даты обязательны — иначе null и кикер без дат. */
function tripDatesLabel(a: string | null, d: string | null): string | null {
  if (!a || !d) return null;
  const s = new Date(`${a}T00:00:00`);
  const e = new Date(`${d}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.getDate()}–${e.getDate()} ${MONTHS_GEN[e.getMonth()]}`;
  }
  return `${s.getDate()} ${MONTHS_GEN[s.getMonth()]} – ${e.getDate()} ${MONTHS_GEN[e.getMonth()]}`;
}

const ACC_LABEL: Record<string, string> = { red: 'красный', orange: 'оранжевый', yellow: 'жёлтый' };
const ACC_VAR: Record<string, string> = { red: 'var(--danger)', orange: 'var(--accent)', yellow: 'var(--warning)' };

function fmtPrice(n: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
}

interface ActiveTrip {
  id: string;
  title: string;
  arrivalDate: string | null;
  departureDate: string | null;
  progress: { day: number | null; total: number | null; phase: 'before' | 'during' | 'after' | 'unknown' };
}

export default function HomeV8Client({ data }: { data: HomeV8Data }) {
  const { safety, seismic, radar, plates, explore, feed, stats, elements, geometry } = data;
  // Лента под первой карточкой — остальные туры, без повтора первого
  // (владелец 25.09: первый тур показывался дважды — крупно и в карусели).
  const more = plates.slice(1);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [chips, setChips] = useState<Record<string, boolean>>({});
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [pdConsent, setPdConsent] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plateIdx, setPlateIdx] = useState(0);
  const [sosOpen, setSosOpen] = useState(false);
  const [openAlert, setOpenAlert] = useState<number | null>(null);
  const [radarOpen, setRadarOpen] = useState(false);
  const leadRef = useRef<HTMLDivElement | null>(null);
  const platesRef = useRef<HTMLDivElement | null>(null);

  // Режим «я в поездке» (коммит 5): единственный источник — auth-scoped
  // GET /api/trips/active (identity из сессии, data:null без режима).
  // Рисуем ТОЛЬКО подтверждённые фазы: during («День N из M» — честная
  // арифметика tripProgress) и before (без выдуманного дня). after и
  // unknown полосы не дают: UI не имеет права подменять unknown числом.
  const [trip, setTrip] = useState<ActiveTrip | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/trips/active', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { data?: ActiveTrip | null } | null) => {
        const d = j?.data;
        if (cancelled || !d || !d.progress) return;
        if (d.progress.phase === 'during' || d.progress.phase === 'before') setTrip(d);
      })
      .catch(() => { /* гость/офлайн — главная без режима поездки */ });
    return () => { cancelled = true; };
  }, []);
  // Свежесть источника — отдельно от состояния. «Спокойно» по позавчерашним
  // данным и «спокойно» по свежим — разные утверждения, и человек должен
  // видеть, какое из них ему показали.
  const fresh = dataFreshness({ updatedAt: safety.updatedAt, source: 'safety' });
  // Состояние обстановки словом. Дроби нет: районного статуса в базе не
  // существует, а знаменатель по 763 точкам читается как шум — см. safety-pill.
  // Свежесть передаётся внутрь (аудит 24.09, #44): «Спокойно» в шапке при
  // «Обстановка недоступна» строкой ниже — это незнание, выданное за покой.
  const pill = safetyPill({ activeCount: safety.activeCount, maxSeverity: safety.maxSeverity, degraded: safety.degraded, freshness: fresh.state });
  // Наличие линии у маршрута (#1643): без связи карта покажет только её.
  // Считается НАЛИЧИЕ, не право вести — право вести решает §12/navigability.
  // null от счётчика — «не посчитано», без точки; не ноль и не 100%.
  const coverage = geometryCoverage({
    total: geometry?.total ?? null,
    withoutTrack: geometry?.without_track ?? null,
  });

  // Поиск ведёт в тот же SSR-листинг, который турист увидит по любой ссылке
  // каталога: одна выдача, а не отдельная «поисковая» ветка со своей правдой.
  // Тема — ЕДИНЫЙ механизм платформы (data-theme + класс .dark + kh-theme),
  // никакого параллельного data-v7theme/v8-theme (снят редизайном 31.07:
  // главная жила в собственной теме, и переключатель на ней не влиял на
  // остальные страницы — а глобальный не влиял на главную).
  useEffect(() => {
    setTheme(readDomTheme());
  }, []);

  const chooseTheme = (t: 'light' | 'dark') => {
    setTheme(t);
    const r = document.documentElement;
    r.setAttribute('data-theme', t);
    r.classList.toggle('dark', t === 'dark');
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* приватный режим */ }
  };

  // Карусель туров: свайп + точки. Автопрокрутки НЕТ (аудит 24.09, #42):
  // карточка уезжала из-под пальца каждые 5 с, пока человек читал цену, а
  // кнопки паузы не было (WCAG 2.2.2). Смещение считается по offsetLeft
  // карточки, а не `i * ширина`: вместе с scroll-padding-inline это держит
  // текст карточки на отступе страницы, а не у самой кромки экрана (#38).
  const PLATES_GUTTER = 20;
  const plateLeft = (c: HTMLElement, i: number): number => {
    const el = c.children[i] as HTMLElement | undefined;
    return el ? Math.max(0, el.offsetLeft - PLATES_GUTTER) : 0;
  };
  useEffect(() => {
    const c = platesRef.current;
    if (!c || more.length < 2) return;
    let t: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        // Активная точка — карточка, чей левый край ближе всего к позиции.
        let best = 0;
        for (let i = 0; i < c.children.length; i++) {
          if (Math.abs(plateLeft(c, i) - c.scrollLeft) < Math.abs(plateLeft(c, best) - c.scrollLeft)) best = i;
        }
        setPlateIdx(best);
      }, 90);
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(t); c.removeEventListener('scroll', onScroll); };
  }, [more.length]);

  const goPlate = (i: number) => {
    const c = platesRef.current;
    if (!c) return;
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    c.scrollTo({ left: plateLeft(c, i), behavior: rm ? 'auto' : 'smooth' });
    setPlateIdx(i);
  };

  const jumpToLead = () => {
    leadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const submitLead = async () => {
    setErr(null);
    // Кнопка не выключается галочкой (аудит 24.09, #3/#5): бледная кнопка
    // без объяснения молчала, а эта ветка была недостижима. Теперь гейт —
    // здесь: запрос без согласия не уходит, человек видит причину рядом с
    // галочкой, и фокус переводится туда, где её исправить.
    const fail = (msg: string, focusId: string) => {
      setErr(msg);
      // focus() не прокручивает, если поле формально в окне — а его может
      // закрывать фиксированный таб-бар. Прокручиваем к ошибке сами, когда
      // она отрисуется.
      document.getElementById(focusId)?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        const target = document.querySelector('.lead [role=alert]') ?? document.getElementById(focusId);
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    };
    if (name.trim().length < 2) { fail('Укажите имя', 'lead-name'); return; }
    if (phone.trim().length < 7) { fail('Укажите телефон или Telegram', 'lead-phone'); return; }
    if (!pdConsent) { fail('Необходимо согласие на обработку персональных данных', 'pd-consent-home'); return; }
    setSending(true);
    try {
      const interests = CHIPS.filter((c) => chips[c]);
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          comment: interests.length ? `Интересы: ${interests.join(', ')}` : undefined,
          source_url: typeof window !== 'undefined' ? window.location.pathname : undefined,
          pd_consent: true,
        }),
      });
      if (!res.ok) throw new Error('fail');
      setSent(true);
    } catch {
      setErr('Не удалось отправить. Попробуйте ещё раз или напишите в Telegram.');
    } finally {
      setSending(false);
    }
  };

  const heroImg = theme === 'dark' ? '/images/hero/hero-dark.jpeg' : '/images/hero/hero-light.jpeg';

  return (
    <div className="v7 v8" id="v8root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* шапка — только функциональное: статус, СОС, тема, ЛК. Бренда здесь
          нет вовсе (итерация north-star 31.07): с брендом даже короткое
          состояние пилюли требовало 427px, то есть на всех ходовых ширинах
          он и так был скрыт. Вордмарк живёт в герое, где ширина не
          конкурирует со статусом безопасности. */}
      <div className="topbar"><div className="in">
        <span className="sp" />
        {/* Обстановка одной строкой. Ведёт к радару на этой же странице — не
            кнопка-обещание, а работающий переход. */}
        <a className={`pill pill-${pill.tone}`} href="#radar">
          <i />{pill.text}
        </a>
        {/* СОС в шапке: одна реализация на всю платформу, офлайн открывает
            инлайн-панель прямо здесь — навигации не происходит вовсе. */}
        <EmergencyAction onOfflineFallback={() => setSosOpen(true)} />
        {/* Иконки поиска здесь больше нет. Она была кнопкой без обработчика:
            выглядела рабочей и не делала ничего. Настоящий поиск — карточкой
            сразу под героем, и место в узкой шапке освободилось. */}
        <button
          className="icn"
          aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          onClick={() => chooseTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark'
            ? <Sun className="li" size={19} strokeWidth={2} />
            : <Moon className="li" size={19} strokeWidth={2} />}
        </button>
        <Link href="/profile" className="icn" aria-label="Личный кабинет">
          <User className="li" size={19} strokeWidth={2} />
        </Link>
        {/* Кнопка «Хочу тур» из шапки убрана. Две причины сошлись.
            Измерение: при 390 px шапка выходила за экран (scrollWidth 417 px),
            и сама кнопка обрезалась на ~27 px — доступное действие выглядело
            сломанным. Прятать overflow нельзя, это спрятало бы действие
            целиком. Смысл: по решению владельца 29.07 тур — не первое
            обещание главной, а следующий шаг после ответа «куда мне можно».
            Действие не потеряно: «Подобрать тур» в блоке Кузьмича зовёт тот
            же jumpToLead. */}
      </div></div>

      {/* ГЕРОЙ — фото-первый, композиция north-star макета (31.07): вордмарк
          на фото, display-заголовок слева, фото внизу растворяется в крем.
          Поиск и чипы поэтому живут НИЖЕ героя на сплошном фоне — и по §2 это
          уже не стекло, а карточки на var(--bg-card).
          При активной поездке герой принадлежит поездке: кикер с реальными
          датами, заголовок — название, «День N из M» — только из tripProgress
          (during) и только при непустых day/total. after/unknown сюда не
          попадают — гейт на fetch выше. */}
      <header className="hero-photo" style={{ backgroundImage: `url('${heroImg}')` }}>
        <div className="hero-shade" aria-hidden />
        <div className="hero-fade" aria-hidden />
        <div className="hero-in">
          {/* Лого — два вулкана (Корякский и Авачинский силуэтом) тонким
              штрихом в гравюрной манере бренда + вордмарк мельче. Текст
              VEDARAI один смотрелся безлико — решение владельца 01.08.
              Справа — «поделиться». Место выбрано не по вкусу: в шапке при
              360 px уже стоят пилюля статуса, СОС, тема и ЛК — пятая иконка
              переносила бы ряд на две строки (шапка потому и умеет
              flex-wrap, что однажды вылезла за экран). В герое ширина
              свободна, а стекло поверх фото разрешено §2. */}
          <div className="hero-top">
            <div className="hero-brand" role="img" aria-label="Vedarai">
              <svg className="hb-mark" viewBox="0 0 72 26" aria-hidden>
                <path d="M1 25 L14 7 L18 12 L22 5 L30 14 L36 25" />
                <path d="M32 25 L46 11 L51 16 L57 10 L71 25" />
                <path d="M20 8 L22 5 L24 8" />
                <path d="M22 5 C21 3 23 2 22 0" opacity=".65" />
              </svg>
              <span className="hb-word">Vedarai</span>
            </div>
            <ShareButton
              className="hero-share"
              referral
              size={18}
              title="Ведар — Камчатка"
              text="Маршруты, безопасность и проверенные туры по Камчатке"
              referralText="Приглашаю в Ведар: маршруты и проверенные туры по Камчатке. По моей ссылке — бонус на первую поездку"
            />
          </div>
          <div className="hero-sp" />
          {trip ? (
            <>
              <div className="hero-kick">
                Ваша поездка
                {tripDatesLabel(trip.arrivalDate, trip.departureDate) && ` · ${tripDatesLabel(trip.arrivalDate, trip.departureDate)}`}
              </div>
              <h1 className="h1-trip">{trip.title}</h1>
              {trip.progress.phase === 'during' && trip.progress.day != null && trip.progress.total != null && (
                <p className="sub">День {trip.progress.day} из {trip.progress.total}</p>
              )}
              {trip.progress.phase === 'before' && trip.progress.total != null && (
                <p className="sub">{trip.progress.total} дн. маршрута впереди</p>
              )}
            </>
          ) : (
            <>
              {/* Заголовок — слово владельца 26.09: «Камчатка по сезону и по
                  силам» (было «Камчатка — без сюрпризов»). Обещает то, что
                  платформа и делает: сезон — из каталога и прогноза, силы —
                  сложность и форма в планировщике. */}
              <h1 className="h1-home">Камчатка<br />по сезону<br />и по силам</h1>
              <p className="sub">Подберём маршрут по вашим датам и реальной обстановке.</p>
            </>
          )}
          {safety.volcanoes[0] && (
            <div className="kvert">
              <i style={{ background: ACC_VAR[safety.volcanoes[0].acc] }} />
              KVERT: {ACC_LABEL[safety.volcanoes[0].acc] ?? safety.volcanoes[0].acc} · {safety.volcanoes[0].name}
            </div>
          )}
        </div>
      </header>

      <div className="wrap">

        {/* ОДИН ПОТОК, А НЕ ДВЕ ДВЕРИ (владелец 25.09). Разделение на блоки
            «Тур с оператором» / «Сам по маршруту» снято тем же вечером:
            «мы нагромождаем — можно же самому подобрать план: сегодня сам,
            завтра с оператором, потом отдых, и так на всё время на Камчатке».
            Поездка — смесь родов дня, а не выбор одной из двух логик; главная
            не заставляет выбирать на входе.

            Строки поиска нет (владелец 25.09: «поиск лишний — всё, что он
            делает, это открывает то, что и так открывается»): она вела в
            выдачу маршрутов по запросу, куда же ведут чипы. */}
        {/* ИНСТРУМЕНТЫ — первыми под героем, над «Турами сезона» (владелец
            26.09: «над туром сезона вставь планировщик и радар»). Ряд встаёт
            на растворяющийся низ фото — место, где раньше стоял первый тур.
            Две плитки-иконки в один ряд (владелец 25.09:
            «планировщик модной иконкой и радар модной иконкой, экономить место
            на мобильной»). Было две полноширинные карточки — плашка
            планировщика и блок обстановки на две строки; стало ~64px на обе.

            Планировщик — по-прежнему дверь с честным именем (владелец 01.08:
            чип «На 3–5 дней» планировщиком не читался). Движок lib/planner.

            Радар несёт оба прибора бывшего блока обстановки, и ни один не
            сокращён до украшения: свежесть — оценкой-точкой на иконке и
            возрастом словами (три состояния: зелёная, жёлтая, у «нет данных»
            точки нет — только контур); доля линий для офлайн-карты — второй
            строкой со своей точкой (#1643, мягкая формулировка владельца
            06.09). Полные строки — в aria-label и title: сокращён
            вид, а не утверждение. Ведёт на /safety#radar — туда же, куда вела
            строка «Радар обстановки» в секции ниже; строка снята как дубль. */}
        <nav className="qtools qt-top" aria-label="Инструменты поездки">
          {/* «Своя поездка» (владелец 25.09: «сегодня сам, завтра с оператором,
              потом отдых — на всё время на Камчатке»). Обещание подписи
              держит движок: день плана несёт род (lib/planner/day-mode). */}
          <Link href="/planner" className="qt qt-plan" aria-label="Своя поездка по дням: дни самостоятельно, туры операторов и отдых на всё время на Камчатке">
            <span className="qt-ic"><CalendarDays size={19} strokeWidth={1.8} aria-hidden /></span>
            <span className="qt-tx"><b>Своя поездка</b><span>сам, тур, отдых</span></span>
          </Link>
          {/* Радар раскрывается по тапу (владелец 26.09, вариант 1 из трёх):
              сводка встаёт под рядом, повторный тап сворачивает. Переход на
              /safety#radar — ссылкой внутри сводки. */}
          <button
            type="button"
            className="qt qt-radar"
            aria-expanded={radarOpen}
            aria-controls="radar-panel"
            aria-label={`Радар обстановки. ${fresh.label}. ${coverage.label}`}
            title={`${fresh.label}. ${coverage.label}`}
            onClick={() => setRadarOpen((o) => !o)}
          >
            <span className="qt-ic">
              <Radar size={19} strokeWidth={1.8} aria-hidden />
              <i
                className="qt-badge"
                style={freshnessDot(fresh.state)
                  ? { background: freshnessDot(fresh.state) as string }
                  : { border: '1px solid var(--text-muted)', background: 'var(--bg-card)' }}
              />
            </span>
            <span className="qt-tx">
              <b>Радар</b>
              <span className="qt-st">{freshnessShort(fresh)}</span>
              <span className="qt-st qt-cov">
                <i
                  style={coverageDot(coverage.state)
                    ? { background: coverageDot(coverage.state) as string }
                    : { border: '1px solid var(--text-muted)' }}
                />
                {coverageShort(coverage)}
              </span>
            </span>
            <ChevronDown className="qt-chev" size={15} strokeWidth={2} aria-hidden />
          </button>
        </nav>
        {radarOpen && (
          <div id="radar-panel" className="radar-panel" role="region" aria-label="Сводка радара">
            <dl>
              <div><dt>Сводка</dt><dd>{fresh.label}</dd></div>
              <div><dt>Предупреждения</dt><dd>{radarAlertsLine(safety)}</dd></div>
              <div><dt>Вулканы</dt><dd>{radarVolcanoLine(safety.volcanoes, safety.degraded, ACC_LABEL)}</dd></div>
              <div><dt>Офлайн-карта</dt><dd>{coverage.label}</dd></div>
            </dl>
            <Link className="an-go" href="/safety#radar">Открыть радар →</Link>
          </div>
        )}

        {/* ТУРЫ СЕЗОНА — сразу под рядом «Своя поездка / Радар» (26.09); первый
            тур с ценой по-прежнему в первом экране (решение владельца 24.09, П4б).
            Решение 29.07 «тур — не первое обещание главной» пересмотрено под
            цель первых продаж: аудит на 390×844 нашёл первую карточку тура на
            894px, то есть на первом экране не было ни тура, ни цены. Карточка
            компактная — фото 16:9 вместо почти квадратного 10/11, — чтобы
            название и цена попадали в первый экран над таб-баром.
            Заголовок нейтральный: «Подходит вам сейчас» обещал подбор,
            которого нет (это просто первый тур витрины по датам и сезону).
            Бейдж — только при спокойной И свежей обстановке: «Сегодня
            спокойно» по недоступной сводке — незнание, выданное за покой (#37).
            Рекламировать тревогу на коммерческой карточке тоже нельзя, поэтому
            в прочих состояниях бейджа нет вовсе. */}
        {plates[0] && (() => {
          const fp = plates[0];
          const f = plateFacts(fp);
          return (
            <section className="fp-sec">
              <div className="shead"><h2>Туры сезона</h2><span className="line" /><Link className="all" href="/catalog">Все туры</Link></div>
              <Link href={fp.kind === 'tour' ? `/marketplace/tours/${fp.id}` : `/routes/${fp.id}`} className="firstpick">
                {/* 1280-вариант вместо оригинала: фон не умеет srcset, но вес
                    режется нарезкой (см. scripts/optimize-images.mjs) — владелец
                    с полевого EDGE ждал оригинал десятки секунд. */}
                <div className="fp-photo" style={fp.imageUrl ? { backgroundImage: `url('${photoSrc(fp.imageUrl, 1280)}')` } : undefined}>
                  {!fp.imageUrl && <span className="noimg" />}
                  <span className="fp-shade" aria-hidden />
                  {pill.tone === 'calm' && fresh.state === 'fresh' && <span className="fp-badge"><i aria-hidden />Сегодня спокойно</span>}
                  <div className="fp-over">
                    <b>{fp.title}</b>
                    <span className="fp-facts">
                      {f.price ? <em>{f.price}</em> : <em>Цена по запросу</em>}
                      {(f.duration || f.operator) && <span>{[f.duration, f.operator].filter(Boolean).join(' · ')}</span>}
                    </span>
                  </div>
                </div>
                <div className="fp-body">
                  {fp.availability === 'season_over' && <span className="fp-avail"><CalendarX aria-hidden size={14} />{AVAILABILITY_LABEL.season_over}</span>}
                  <span className="fp-cta">{fp.kind === 'tour' ? 'Смотреть тур' : 'Открыть маршрут'}</span>
                </div>
              </Link>
              {/* Остальные туры — лентой под первым, в той же секции. До 25.09
                  они жили ниже под заголовком «Исследовать» и начинались с того
                  же первого тура: одна карточка дважды на одном экране. */}
              {more.length > 0 && (
                <>
                  <div className="plates more-tours" ref={platesRef}>
                    {more.map((p, i) => {
                      const href = p.kind === 'tour' ? `/marketplace/tours/${p.id}` : `/routes/${p.id}`;
                      const pf = plateFacts(p);
                      const meta = [pf.duration, pf.operator].filter(Boolean).join(' · ');
                      return (
                        <figure className="plate" key={p.id} role="group" aria-label={`Тур ${i + 2} из ${plates.length}`}>
                          <Link href={href} tabIndex={-1} aria-hidden><div className="img" style={p.imageUrl ? { backgroundImage: `url('${photoSrc(p.imageUrl, 640)}')` } : undefined}>
                            {!p.imageUrl && <span className="noimg" />}
                          </div></Link>
                          <div className="row"><b>{p.title}</b></div>
                          {p.description && <div className="cap">{p.description}</div>}
                          <div className="facts">
                            {pf.price ? <span className="price">{pf.price}</span> : <span className="price muted">Цена по запросу</span>}
                            {meta && <span className="meta">{meta}</span>}
                          </div>
                          {/* Условия отмены — дословно из поля тура (решение владельца
                              24.09 п.3): своей сетки сроков и процентов здесь нет. */}
                          {p.cancellationPolicy && <div className="cancel">{p.cancellationPolicy}</div>}
                          {p.availability === 'season_over' && <div className="avail"><CalendarX aria-hidden size={14} />{AVAILABILITY_LABEL.season_over}</div>}
                          <div className="buy">
                            <Link className="buy-cta" href={href}>{p.kind === 'tour' ? 'Смотреть тур' : 'Открыть'}</Link>
                          </div>
                        </figure>
                      );
                    })}
                  </div>
                  {more.length > 1 && (
                    <div className="pl-dots">
                      {more.map((_, i) => (
                        <button key={i} className={i === plateIdx ? 'on' : ''} aria-label={`Тур ${i + 2} из ${plates.length}`} aria-current={i === plateIdx ? 'true' : undefined} onClick={() => goPlate(i)} />
                      ))}
                    </div>
                  )}
                </>
              )}
              {feed.length > 0 && (
                <div className="arrivals"><span className="k">Журнал</span><span className="t">{feed[0].text}</span></div>
              )}
            </section>
          );
        })()}
        <div className="hero-chips">
          {INTENT_CHIPS.map((c) => {
            const Ic = CHIP_ICON[c.key];
            return (
              <Link key={c.key} href={c.href} className="hchip">
                {Ic && <Ic size={17} strokeWidth={2} aria-hidden />}
                <span className="hc-l">{c.label}</span>
              </Link>
            );
          })}
        </div>




        {/* АКТИВНАЯ ПОЕЗДКА — только при подтверждённом режиме (см. выше).
            Заголовок и день живут в герое; здесь — плитки-входы. Только
            работающие: навигатор, радар, офлайн-карта. Никаких «следующая
            точка N» — связи день→точка в данных нет. */}
        {trip && (
          <section className="tripstrip" aria-label="Активная поездка">
            <div className="shead"><h2>Сводка по вашему району</h2><span className="line" /></div>
            <div className="ts-tiles">
              {/* Навигатор — жёсткая ссылка (не Next Link): офлайн должна
                  грузиться закэшированная страница, а не заглушка. */}
              <a href="/planning?mode=trail" className="ts-tile">
                <Navigation size={20} strokeWidth={1.8} aria-hidden />
                <b>Навигатор</b>
                <span>работает без сети</span>
              </a>
              <Link href="/safety#radar" className="ts-tile">
                <Radar size={20} strokeWidth={1.8} aria-hidden />
                <b>Радар</b>
                <span>обстановка вживую</span>
              </Link>
              <Link href="/map" className="ts-tile">
                <MapIcon size={20} strokeWidth={1.8} aria-hidden />
                <b>Офлайн-карта</b>
                <span>скачать область</span>
              </Link>
            </div>
          </section>
        )}


        {/* ПЕРЕД ВЫХОДОМ — вся безопасность одним местом (владелец 25.09:
            «блок „Перед выходом“: вся безопасность в одном месте»). Прежде
            предупреждения стояли под турами отдельной рамкой, а полевые
            инструменты — ниже карусели, без заголовка. Теперь одна секция:
            сначала что случилось, потом что сделать до выхода и в поле.
            Якорь #radar остался — на него ведёт пилюля шапки; сводка радара
            раскрывается плиткой в ряду инструментов наверху. */}
        <section id="radar" className="sub radar-sec">
          <div className="shead"><h2>Перед выходом</h2><span className="line" /><Link className="all" href="/safety">Безопасность</Link></div>
          {/* ЧТО ИМЕННО СЛУЧИЛОСЬ. Пилюля в шапке и строка выше сообщают
              СОСТОЯНИЕ — цветную точку и одно слово. Содержания опасности на
              главной не было вовсе: сама лента предупреждений жила только на
              /safety, за переходом. Владелец открыл сайт при девятнадцати
              действующих предупреждениях, из них одно важности 2, и сказал: «ни
              слова об опасности». Он прочитал ровно то, что было написано.

              Здесь — текст. Не больше двух строк: главная не подменяет /safety,
              но и не молчит о том, что там ждёт. Блока нет, когда предупреждений
              нет: пустая рамка «всё спокойно» — это обещание, которого мы дать
              не можем. */}
          {safety.alerts.length > 0 && (
            <div className="alerts-now" role="region" aria-label="Действующие предупреждения">
              {/* Строка — кнопка-раскрытие (владелец 25.09: «на 3 строчки,
                  интерактивные, с раскрытием при тапе и закрытием»). Свёрнутая —
                  заголовок до трёх строк CSS-обрезкой, а не clip(…, 90): обрезка
                  по символам съедала хвост на середине слова («в районе села
                  Соболево до…») и прятала именно срок и место. Раскрытая —
                  заголовок целиком и описание: в description лежит деталь
                  (объезд, окна проезда), ради которой человек и нажал. */}
              <ul>
                {safety.alerts.slice(0, 2).map((a, i) => {
                  const open = openAlert === i;
                  const body = alertBody(a);
                  return (
                    <li key={`${a.title}-${i}`}>
                      <button
                        type="button"
                        className="an-row"
                        aria-expanded={open}
                        onClick={() => setOpenAlert(open ? null : i)}
                      >
                        <i className={a.severity >= 2 ? 'sev-hi' : a.severity === 1 ? 'sev-mid' : 'sev-lo'} />
                        <span className="an-tx">
                          <span className={open ? 'an-t' : 'an-t an-clamp'}>{open && body.replacesTitle ? body.text : a.title}</span>
                          {open && body.text && !body.replacesTitle && <span className="an-d">{body.text}</span>}
                          <span className="an-st">{stampAlert(a)}</span>
                        </span>
                        <ChevronDown className="an-chev" size={16} strokeWidth={2} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <Link className="an-go" href="/safety">
                {safety.alerts.length > 2
                  ? `Все предупреждения (${alertsCountLabel(safety.alerts.length)}) →`
                  : 'Подробности →'}
              </Link>
            </div>
          )}

          {/* Четыре полевых инструмента — сеткой 2×2 тех же плиток, что
              «Планировщик» и «Радар» выше (владелец 25.09: «место жалко на
              главной»). Было четыре полноширинные строки с подписью в две
              строки каждая. Полная фраза каждой — в aria-label и title:
              сокращён вид, а не обещание. МЧС сохраняет свою тёплую
              подложку (.mchsline, --warning, не --danger): это просьба,
              а не тревога. */}
          <nav className="qtools stools" aria-label="Безопасность в поле">
            <Link
              href="/register"
              className="qt mchsline"
              aria-label="Регистрация перед выходом: маршрут в МЧС заранее, бесплатно, и разрешение природного парка — «Зелёная кнопка»"
              title="Маршрут в МЧС заранее — бесплатно; в природный парк — ещё разрешение, «Зелёная кнопка»"
            >
              <span className="qt-ic"><ClipboardCheck size={19} strokeWidth={1.8} aria-hidden /></span>
              <span className="qt-tx"><b>Регистрация</b><span>МЧС и парк</span></span>
            </Link>

            <Link
              href="/safety/offline"
              className="qt"
              aria-label="Что делать при ЧП: медведь, холод, вулкан, потерялся. Работает без сети"
              title="Что делать при ЧП: медведь · холод · вулкан · потерялся"
            >
              <span className="qt-ic"><LifeBuoy size={19} strokeWidth={1.8} aria-hidden /></span>
              <span className="qt-tx"><b>Если ЧП</b><span>памятка без сети</span></span>
            </Link>

            {/* Навигатор — жёсткая ссылка (не Next Link): чтобы офлайн грузилась
                закэшированная страница, а не заглушка «Нет соединения». */}
            <a
              href="/planning?mode=trail"
              className="qt"
              aria-label="Навигатор по маршруту: компас до точки, высота, трек. Работает без сети"
              title="Навигатор по маршруту: компас до точки, высота, трек"
            >
              <span className="qt-ic"><Compass size={19} strokeWidth={1.8} aria-hidden /></span>
              <span className="qt-tx"><b>Навигатор</b><span>компас без сети</span></span>
            </a>

            {/* Кнопки создания наблюдения на главной больше НЕТ (владелец
                27.08): наблюдение создаётся с экрана маршрута, где координаты
                и офлайн-очередь система даёт сама — прежняя форма отсюда без
                сети теряла текст. Жёсткая ссылка по той же причине, что у
                навигатора выше.
                obs=1 (владелец 29.08) — ссылка обещает открыть форму
                наблюдения, а без флага открывался общий экран «Куда хотите
                пойти?»: заголовок звал в форму, а показывалась другая. */}
            <a
              href="/planning?mode=trail&obs=1"
              className="qt"
              aria-label="Сообщить о наблюдении с экрана маршрута: фото, координаты, без сети"
              title="Сообщить о наблюдении с экрана маршрута"
            >
              <span className="qt-ic"><Camera size={19} strokeWidth={1.8} aria-hidden /></span>
              <span className="qt-tx"><b>Наблюдение</b><span>фото без сети</span></span>
            </a>
          </nav>

        </section>

        {/* ИССЛЕДОВАТЬ — направление «сам» (владелец 25.09: «это же 2 разных
            направления, и они объединяются в планировщике»). Туры — выше, в
            «Турах сезона»; здесь места: географический факт без цены и брони
            (§9). Та же выдача и тот же порядок, что в каталоге мест
            (/routes?kind=place): со снимком впереди, без снимка — в конце. */}
        {explore.length > 0 && (
          <section className="explore-sec">
            <div className="shead"><h2>Исследовать</h2><span className="line" /><Link className="all" href="/routes?kind=place">Все места</Link></div>
            <div className="plates explore">
              {explore.map((pl, i) => (
                <Link key={pl.id} href={`/places/${pl.id}`} className="plate place" aria-label={`${pl.title}, место ${i + 1} из ${explore.length}`}>
                  <div className="img" style={pl.imageUrl ? { backgroundImage: `url('${photoSrc(pl.imageUrl, 640)}')` } : undefined}>
                    {!pl.imageUrl && <span className="noimg" />}
                  </div>
                  <span className="kind">{pl.typeLabel}</span>
                  <div className="row"><b>{pl.title}</b></div>
                  {pl.description && <div className="cap">{pl.description}</div>}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* III. КУЗЬМИЧ */}
        <section>
          <div className="shead"><h2>Проводник Кузьмич</h2><span className="line" /></div>
          <div className="guide">
            <div className="gtop">
              <img
                className="face"
                src="/images/kuzmich/portrait-192.webp"
                srcSet="/images/kuzmich/portrait-96.webp 96w, /images/kuzmich/portrait-192.webp 192w, /images/kuzmich/portrait-384.webp 384w"
                sizes="72px"
                width={72}
                height={72}
                alt="Кузьмич"
                loading="lazy"
                decoding="async"
              />
              <q>Скажите, что хотите увидеть — соберу маршрут по реальным статусам и передам проверенному оператору.</q>
            </div>
            <div className="sig"><span className="caps">Кузьмич</span><span className="dot" /><span className="mono">по данным, не по слухам</span></div>
            <div className="acts">
              <Link href="/kuzmich">Спросить</Link>
              {/* Класс НЕ «lead»: на ссылку каскадом падало правило ФОРМЫ
                  .v7 .lead (border+padding 20px) — «Подобрать тур» раздувался
                  в короб и ломал ряд (полевой скриншот 01.08, 17:17). */}
              <a className="golead" onClick={(e) => { e.preventDefault(); jumpToLead(); }} href="#lead">Подобрать тур</a>
            </div>
          </div>
        </section>

        {/* Второй слой той же двери: выбор по стихии. Отдельной секцией это
            было третьим входом в тот же каталог. */}
        {elements.length > 0 && (
          <section className="sub">
            <div className="elements">
              {elements.map((el, i) => {
                const Icon = ELEMENT_ICON[el.key] ?? Flame;
                const wide = elements.length % 2 === 1 && i === elements.length - 1;
                return (
                  <Link className={`etile et-${el.key}`} href={el.href} key={el.key}
                    style={wide ? { gridColumn: 'span 2' } : undefined}>
                    <span className="glass">
                      <Icon className="eicon" size={24} strokeWidth={1.6} aria-hidden />
                      <b>{el.label}</b>
                      <span className="ecnt">{el.count} {plural(el.count, 'место', 'места', 'мест')}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* V. ЦИФРЫ */}
        <section>
          <div className="shead"><h2>В цифрах</h2><span className="line" /></div>
          <div className="dataline">
            {stats.map((s, i) => (
              s.href
                ? <Link className="dl link" href={s.href} key={i}><div className="n">{s.value}</div><div className="t">{s.label} →</div></Link>
                : <div className="dl" key={i}><div className="n">{s.value}</div><div className="t">{s.label}</div></div>
            ))}
          </div>
        </section>

        {/* Сбор поездки — действие Кузьмича, а не отдельная секция-двойник.
            Заголовок «Собрать поездку» снят: он повторял то, что уже обещает
            блок проводника выше, и добавлял главной ещё один вход в то же
            самое. Форма и её POST /api/leads остались нетронутыми, ссылка
            «Подобрать тур» у Кузьмича по-прежнему ведёт сюда. */}
        <section ref={leadRef} id="lead" className="sub">
          <div className={`lead${sent ? ' sent' : ''}`}>
            <h3>Не знаете, <em>с чего начать</em>?</h3>
            <p>Опишите поездку — подберём маршруты и передадим проверенным операторам. Ответ сегодня.</p>
            <div className="chips">
              {CHIPS.map((c) => (
                <button key={c} className="chip" aria-pressed={!!chips[c]}
                  onClick={() => setChips((s) => ({ ...s, [c]: !s[c] }))}>{c}</button>
              ))}
            </div>
            <div className="field2">
              <input id="lead-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Как вас зовут" aria-label="Имя" />
              <div className="field">
                <input id="lead-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Телефон или Telegram" aria-label="Контакт" />
                <button onClick={submitLead} disabled={sending}>{sending ? '…' : 'Отправить'}</button>
              </div>
            </div>
            <div className="fine">
              <PdConsentCheckbox checked={pdConsent} onChange={setPdConsent} id="pd-consent-home" />
            </div>
            {err && <div className="err" role="alert">{err}</div>}
            <div className="fine">Данные уходят только операторам по вашему запросу. Без спама.</div>
            <div className="ok">Заявка принята. Кузьмич собирает подборку — оператор ответит в течение дня.</div>
          </div>
        </section>

        {/* Ряда разделов («Туристам», «Рыбалка», «Операторам», «Гидам»,
            «Жильё», «Снаряжение») внизу больше нет — владелец 26.09: «подвал
            вообще не то и не работает, убрать». Разделы доступны из таб-бара
            (Туры, Карта), из ЛК в шапке и из самих страниц. */}
      </div>

      {/* Шторки наблюдения здесь больше нет: создание переехало на экран
          маршрута (ObservationSheet в полевом контуре, владелец 27.08). */}

      {/* Нижняя навигация — ЕДИНЫЙ BottomNav платформы (решение владельца
          2026-07-18). Собственный инлайновый таб-бар главной удалён редизайном
          31.07: два таб-бара с одинаковыми пунктами неизбежно разъезжаются
          подписями и адресами — это уже случалось (/map и /ai-assistant). */}
      <BottomNav activePath="/" />

      <EmergencyPanel open={sosOpen} onClose={() => setSosOpen(false)} />
    </div>
  );
}

/**
 * Инлайн-панель экстренной помощи — открывается ПОВЕРХ главной, без перехода
 * на другую страницу и без сети. Всё критичное зашито статикой: звонки (tel:),
 * координаты (navigator.geolocation), протоколы (текст). Полевой тест на Трёх
 * братьях показал, что офлайн выживает только контент на уже загруженной
 * главной — навигация на /sos умирает (Next тянет данные экрана по сети).
 * Номера — из единого источника lib/safety/emergency-numbers.ts. Протоколы — из /safety/offline.
 */
// Единый источник номеров (см. lib/safety/emergency-numbers.ts).
// tel: — только цифры и «+»: форматированный «+7 (4152) 30-10-89» с пробелами
// ломает tel-ссылку на части устройств.
const EMG_CALLS: { label: string; num: string; tel: string; primary?: boolean }[] =
  EMERGENCY_NUMBERS.map((c) => ({
    label: c.name,
    num: c.phone,
    tel: c.phone.replace(/[^\d+]/g, ''),
    primary: c.primary,
  }));

const EMG_PROTOCOLS: { id: string; title: string; urgent: string; steps: string[] }[] = [
  {
    id: 'bear', title: 'Медведь', urgent: 'Никогда не беги — сработает инстинкт преследования',
    // Тактика при нападении выправлена 01.08.2026 по разбору экспертов проекта
    // «Земля медведя» (Фонд защитников природы; охотовед Кроноцкого заповедника):
    // «бей в нос и глаза, не ложись» — миф из доктрины чёрных медведей, которых на
    // Камчатке нет. Для бурого при неизбежном контакте — сгруппироваться, защитить
    // голову/шею/живот и НЕ сопротивляться; активная драка уместна только против
    // явного хищнического нападения (крайне редкий случай — шатун).
    steps: [
      'Не заметил тебя — тихо уйди по большой дуге, не привлекая внимания.',
      'Заметил — остановись. Говори спокойным низким голосом: покажи, что ты человек.',
      'Выгляди крупнее: подними руки или рюкзак над головой. Антизверь наготове.',
      'Медленно отступай боком, не поворачивайся спиной.',
      'Признаки агрессии: мотание головой, фырканье, слюна, ложные выпады. Встал на задние лапы — любопытство, не атака.',
      'Сближается — антизверь навстречу. Контакта не избежать: сгруппируйся, защити голову, шею и живот, не сопротивляйся.',
      'Медвежата — рядом медведица: уходи немедленно, не приближайся.',
    ],
  },
  {
    id: 'hypothermia', title: 'Гипотермия', urgent: 'Дрожь прекратилась, человек вялый — критическая стадия',
    steps: [
      'Убери от ветра, сними мокрое, укутай в спальник, поделись теплом тела.',
      'Нет дрожи, спутанность: горизонтально, не двигай — может остановить сердце.',
      'Тёплое питьё — только если в сознании и глотает сам. Алкоголь запрещён.',
      'Грей тело (грудь, подмышки, пах), не конечности.',
      'Мокрая одежда крадёт тепло в 25× быстрее. Приоритет — сухость.',
      'Звони 112, передай координаты, не оставляй одного.',
    ],
  },
  {
    id: 'lost', title: 'Потерялся', urgent: 'СТОП — стой где стоишь, не паникуй',
    steps: [
      'S.T.O.P.: стой, думай, осмотрись, планируй.',
      'Не иди наугад — каждый шаг удаляет от зоны поиска.',
      'Нужна вода/люди — иди вниз по склону к реке.',
      'Три костра треугольником — сигнал бедствия.',
      'Ночлег: лапник 15 см — тепло снизу важнее укрытия сверху.',
      'Береги заряд: авиарежим, геолокацию включай только для звонка.',
    ],
  },
  {
    id: 'volcano', title: 'Вулкан', urgent: 'Запах серы + тремор земли = уходи немедленно',
    steps: [
      'Признаки: запах серы, подземный гул, тремор, гибель птиц.',
      'Пепел: закрой рот и нос тканью, двигайся перпендикулярно ветру.',
      'Лавовый поток медленный — уходи вверх по склону, в сторону от потока.',
      'Термальные поля: не ступай на белую/жёлтую землю — под коркой кипяток.',
    ],
  },
];

function EmergencyPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoState, setGeoState] = useState<'idle' | 'ok' | 'deny'>('idle');
  const [copied, setCopied] = useState(false);
  const [openProto, setOpenProto] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !navigator.geolocation) { if (open) setGeoState('deny'); return; }
    setGeoState('idle');
    navigator.geolocation.getCurrentPosition(
      (p) => { setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }); setGeoState('ok'); },
      () => setGeoState('deny'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }, [open]);

  if (!open) return null;

  const coordText = coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : '';
  const copy = () => {
    if (!coordText) return;
    navigator.clipboard?.writeText(coordText)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };
  const smsBody = coords ? `SOS. Нужна помощь. Мои координаты: ${coordText}` : 'SOS. Нужна помощь.';

  return (
    <div className="emg" role="dialog" aria-label="Экстренная помощь">
      <div className="emg-top">
        <b>Экстренная помощь</b>
        <button className="emg-x" onClick={onClose} aria-label="Закрыть"><X size={20} strokeWidth={2.2} /></button>
      </div>

      <div className="emg-scroll">
        {/* Координаты — работают без сети */}
        <div className="emg-coord">
          <span className="emg-lbl"><MapPin size={13} strokeWidth={2} /> Твои координаты</span>
          {geoState === 'ok' && coords ? (
            <button className="emg-cval" onClick={copy}>
              {coordText}<span>{copied ? 'скопировано' : 'копировать'}</span>
            </button>
          ) : geoState === 'deny' ? (
            <span className="emg-cwait">Разреши геолокацию и включи GPS</span>
          ) : (
            <span className="emg-cwait">Определяю позицию…</span>
          )}
        </div>

        {/* Звонки — работают без интернета */}
        <div className="emg-calls">
          {EMG_CALLS.map((c) => (
            <a key={c.tel} href={`tel:${c.tel}`} className={`emg-call${c.primary ? ' emg-call-primary' : ''}`}>
              <Phone size={c.primary ? 22 : 17} strokeWidth={2.2} />
              <span className="emg-ct"><b>{c.num}</b><span>{c.label}</span></span>
            </a>
          ))}
          <a href={`sms:112?body=${encodeURIComponent(smsBody)}`} className="emg-sms">
            SMS на 112 с координатами
          </a>
        </div>

        {/* Протоколы — текст зашит, без сети */}
        <div className="emg-protos">
          <span className="emg-lbl">Что делать при ЧП</span>
          {EMG_PROTOCOLS.map((p) => (
            <div key={p.id} className="emg-proto">
              <button className="emg-phead" onClick={() => setOpenProto(openProto === p.id ? null : p.id)} aria-expanded={openProto === p.id}>
                <span className="emg-pt"><b>{p.title}</b><span>{p.urgent}</span></span>
                <ChevronDown size={16} strokeWidth={2} className={openProto === p.id ? 'emg-chev emg-chev-on' : 'emg-chev'} />
              </button>
              {openProto === p.id && (
                <ol className="emg-steps">
                  {p.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>
          ))}
        </div>

        <p className="emg-note">Работает без интернета. Звонок 112 проходит даже без SIM и с чужой сетью.</p>
      </div>
    </div>
  );
}

const CSS = `
/* Токены — ТОЛЬКО глобальные (globals.css). Собственная палитра v7
   (--shroom/--tide/--fd/--fb, теневой --danger, темы data-v7theme)
   снята редизайном 31.07: главная красилась и переключала тему отдельно
   от платформы. Локальным остаётся один шрифтовой стек моно-тегов. */
.v7{
  --fm:var(--font-jetbrains),ui-monospace,monospace;
}
.v7 *{margin:0;padding:0;box-sizing:border-box}
.v7{font-family:var(--font-outfit),system-ui,sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100dvh;padding-bottom:calc(96px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}
@media (prefers-reduced-motion:reduce){.v7 *,.v7 *::before,.v7 *::after{animation:none!important;transition:none!important}}
.v7 .wrap{max-width:480px;margin:0 auto;padding:0 20px}
.v7 .li{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;display:block}
.v7 a{color:inherit;text-decoration:none}
.v7 .ptag{font:400 9px/1 var(--fm);letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted)}
.v7 .topbar{position:sticky;top:0;z-index:55;background:color-mix(in srgb,var(--bg-primary) 94%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
/* Перенос в шапке ЗАПРЕЩЁН (владелец 02.09, скрин «шапка съехала»).
   Страховка #893 (flex-wrap:wrap) на узком экране уносила ЛК на вторую
   строку — вместо «уехало за край» получилось «шапка съехала». Бюджет
   ширины сходится без переноса и без сжатия: поля 14px, зазор 6px,
   самое длинное состояние пилюли укорочено («Нет данных», safety-pill.ts),
   SOS не сжимается (flexShrink 0). Обрезать пилюлю многоточием по-прежнему
   нельзя (833120d). Замер 02.09 (Inter): худшее состояние 146 + SOS 73 +
   иконки 88 + зазоры 24 = 331 при доступных 332 на 360px. На 320px не
   сходится — там переполнения не избежать без потери элемента; это
   известный долг, а не регрессия. Числа — scripts/measure-header-budget.mjs. */
.v7 .topbar .in{max-width:480px;margin:0 auto;padding:10px 14px;display:flex;align-items:center;gap:6px;flex-wrap:nowrap}
/* Бренда в шапке НЕТ (итерация north-star 31.07). Измерение 31.07 показало:
   с брендом даже худшее короткое состояние пилюли требовало 427px — на всех
   ходовых мобильных ширинах бренд был скрыт media-query, то есть фактически
   его уже не существовало. Вместо мёртвого порога — честное место: serif-
   вордмарк в герое (.hero-brand), где ширина не конкурирует со статусом
   безопасности и SOS. Бюджет шапки: пилюля + SOS + 2 иконки + зазоры. */
.v7 .topbar .sp{flex:1}
/* 44x44 — правило §3 дизайн-языка, а не уступка ревью. Иконка внутри остаётся
   19px: компактность держим внутренним размером глифа, а не урезанием зоны
   нажатия.
   flex:none обязателен. Объявленных 44px недостаточно: у флекс-ребёнка работает
   дефолтный flex-shrink:1, и в тесной шапке зона нажатия сжималась до 19-37px
   (измерено, issue #893) — то есть до размера самого глифа, при формально
   правильном CSS. Сторож на объявленную высоту этого не видел: ломал layout, а
   не декларация. flex:none закрывает слепое пятно по построению — сжиматься
   больше нечему. */
.v7 .icn{width:44px;height:44px;flex:none;display:grid;place-items:center;color:var(--text-secondary);font-size:15px;cursor:pointer;background:none;border:0}
.v7 .icn .li{width:19px;height:19px}
/* Обстановка одной строкой; цвет несёт состояние, а не украшает.
   flex:none и никакого многоточия: на боевом экране 1080px пилюля ужималась
   до «Сегодня: оп» — обрезанная «опасность» выглядит как исправный индикатор
   и не читается. Статус безопасности либо виден целиком, либо это не статус. */
/* Пилюля — единственное, что в шапке умеет ужиматься (02.09, скрин
   владельца: «5+ предупреждений» + SOS + две иконки не влезли, ЛК уехал на
   вторую строку). flex:0 1 auto и min-width:0 — чтобы ужаться могла именно
   она, а не зоны нажатия (те держат flex:none, #893); текст — в .pt с
   многоточием: у анонимного текстового флекс-ребёнка обрезки нет. */
.v7 .pill{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:44px;padding:0 9px;border-radius:999px;text-decoration:none;font:600 10.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.02em;color:var(--text-primary);border:1px solid var(--border);white-space:nowrap;transition:background .2s}
.v7 .pill i{width:7px;height:7px;border-radius:50%;flex:none}
.v7 .pill-calm i{background:var(--success)}
/* Незнание — не спокойствие: приглушённый серый, а не зелёный. */
.v7 .pill-unknown i{background:var(--text-muted)}
.v7 .pill-warning i{background:var(--warning)}
.v7 .pill-danger{border-color:color-mix(in srgb,var(--danger) 55%,transparent)}
.v7 .pill-danger i{background:var(--danger)}
/* ГЕРОЙ фото */
/* Высота героя: 76vh + шапка 56px + нижняя навигация съедали ровно весь первый
   экран — под сгибом не оставалось НИЧЕГО, и «Радар» приходилось искать
   прокруткой, не зная, что он там есть. Теперь герой отдаёт полосу следующему
   блоку: видно, что страница продолжается. dvh, а не vh, — чтобы прячущаяся
   панель браузера не дёргала высоту (vh оставлен первой строкой как запасной
   для старых движков). На широком экране места больше, там герой крупнее. */
/* Высота героя: без ограничения он с шапкой и навигацией съедал весь первый
   экран. 62dvh держался с north-star 31.07; 05.09 владелец попросил герой
   короче — 50dvh: заголовок и подзаголовок в две строки помещаются, а строка
   поиска и чипы поднимаются в первый экран без прокрутки. Растворение в крем
   осталось: видно, что страница продолжается, и шов между фото и подложкой
   не режет глаз (dvh — чтобы панель браузера не дёргала высоту; vh —
   запасной для старых движков). */
.v7 .hero-photo{position:relative;min-height:46vh;min-height:46dvh;background-size:cover;background-position:center;display:flex;color:#fff}
@media (min-width:768px){.v7 .hero-photo{min-height:70vh;min-height:70dvh}}
/* Тени — отдельными слоями, а не в background-image строки: верхняя вуаль под
   вордмарк, нижняя под заголовок, и поверх обеих — растворение в крем.
   Растворение идёт В ЦВЕТ ТЕМЫ (var(--bg-primary)), поэтому переключение
   светлая/тёмная не оставляет чужого шва под героем. */
.v7 .hero-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,14,12,.44) 0%,rgba(10,14,12,.10) 30%,rgba(10,14,12,.46) 68%,rgba(10,14,12,.30) 100%)}
.v7 .hero-fade{position:absolute;left:0;right:0;bottom:-1px;height:110px;background:linear-gradient(180deg,transparent 0%,var(--bg-primary) 92%)}
.v7 .hero-in{position:relative;max-width:480px;margin:0 auto;padding:16px 20px 80px;width:100%;display:flex;flex-direction:column;align-items:flex-start;text-align:left}
/* Лого — вулканы штрихом + вордмарк. Живёт на фото: в шапке ему не
   хватало бюджета ширины (см. комментарий у .topbar). */
.v7 .hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;width:100%}
.v7 .hero-brand{display:flex;flex-direction:column;gap:7px;filter:drop-shadow(0 1px 10px rgba(0,0,0,.45))}
/* Стекло — поверх фото, где ему и место по §2. */
.v7 .hero-share{width:40px;height:40px;flex:none;display:grid;place-items:center;border-radius:999px;background:rgba(0,0,0,.40);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.95);cursor:pointer;transition:background .2s}
.v7 .hero-share:hover{background:rgba(0,0,0,.55)}
.v7 .hb-mark{width:52px;height:auto;stroke:rgba(255,255,255,.95);fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.v7 .hb-word{font:600 11px/1 var(--font-playfair),Georgia,serif;letter-spacing:.38em;text-transform:uppercase;color:rgba(255,255,255,.95)}
.v7 .hero-sp{flex:1;min-height:28px}
/* Display-типографика — главный визуальный удар макета. clamp: на 320px не
   рвёт слова, на 480px не превращается в плакат. */
.v7 .hero-photo h1{font:600 clamp(38px,11.6vw,48px)/1.06 var(--font-playfair),Georgia,serif;letter-spacing:-.02em;text-shadow:0 2px 28px rgba(0,0,0,.45)}
.v7 .hero-photo h1.h1-trip{font-size:clamp(30px,9vw,40px);line-height:1.12}
/* «Камчатка / по сезону / и по силам» (владелец 26.09) — три строки по
   смыслу, а не как ляжет: иначе рвалось «по сезону и по / силам». Кегль чуть
   меньше прежнего, чтобы над «Турами сезона» встал ряд «Своя поездка / Радар»
   и цена первого тура осталась в первом экране над таб-баром (П4б, 24.09). */
.v7 .hero-photo h1.h1-home{font-size:clamp(34px,10.4vw,44px);line-height:1.04}
.v7 .hero-kick{margin-bottom:10px;font:600 10px/1.4 var(--fm);letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.85)}
.v7 .hero-photo .sub{margin-top:12px;font:500 14px/1.55 var(--font-outfit),system-ui,sans-serif;color:rgba(255,255,255,.92);max-width:34ch}
.v7 .hero-photo .kvert{margin-top:14px;display:inline-flex;align-items:center;gap:8px;font:400 9.5px/1 var(--fm);letter-spacing:.08em;color:rgba(255,255,255,.85)}
.v7 .hero-photo .kvert i{width:7px;height:7px;border-radius:50%}
/* Первый блок встаёт на растворяющийся низ фото — место, где раньше лежала
   строка поиска (снята 25.09). */
.v7 nav.qt-top{position:relative;z-index:2;margin:-16px 0 0}
.v7 section.fp-sec{margin-top:12px}
.v7 .fp-sec .shead{margin-bottom:8px}
/* Чипы — ОДИН ряд плиток (владелец 25.09: «занимают 2 строчки, не
   экономно»). Иконка над подписью: в ширину телефона 360px пилюли в строку не
   входят, а столбиком входят — 56px вместо двух рядов по 44. Колонок столько,
   сколько чипов: grid-auto-flow:column, числа в CSS нет. */
.v7 .hero-chips{margin-top:10px;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px}
.v7 .hchip{min-height:56px;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:6px 2px;border-radius:14px;text-decoration:none;color:var(--text-primary);font:600 10.5px/1.15 var(--font-outfit),system-ui,sans-serif;text-align:center;background:var(--bg-card);border:1px solid var(--border);transition:transform .13s ease,background .2s ease}
.v7 .hchip .hc-l{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v7 .hchip svg{color:var(--text-secondary)}
.v7 .qtools{margin:10px 0 26px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.v7 .qt{min-height:64px;min-width:0;display:flex;align-items:center;gap:8px;padding:8px;border-radius:16px;text-decoration:none;background:var(--bg-card);border:1px solid var(--border);transition:transform .13s ease,background .2s ease}
.v7 .qt:hover{background:var(--bg-hover)}
.v7 .qt:active{transform:scale(.98)}
.v7 .qt-ic{position:relative;flex:none;width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:var(--ocean);background:color-mix(in srgb,var(--ocean) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ocean) 18%,transparent)}
.v7 button.qt{font:inherit;color:inherit;text-align:left;width:100%;cursor:pointer;-webkit-tap-highlight-color:transparent}
.v7 .qt-radar{position:relative}
.v7 .qt-chev{position:absolute;top:8px;right:8px;color:var(--text-secondary);transition:transform .2s ease}
.v7 .qt-radar[aria-expanded="true"] .qt-chev{transform:rotate(180deg)}
/* Сводка радара — непрозрачная карточка под рядом: это прибор, не стекло (§2). */
.v7 .radar-panel{position:relative;z-index:2;margin:8px 0 0;padding:10px 14px 4px;background:var(--bg-card);border:1px solid color-mix(in srgb,var(--success) 32%,transparent);border-radius:16px}
.v7 .radar-panel dl{margin:0;display:grid;gap:10px}
.v7 .radar-panel dl > div{display:grid;gap:2px}
.v7 .radar-panel dt{font:600 10.5px/1.3 var(--font-outfit),system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary)}
.v7 .radar-panel dd{margin:0;font:500 13px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
/* Радар — зелёный (владелец 26.09: «радар сделай зелёным»). Зелёный здесь —
   цвет прибора, как тёплая подложка у МЧС, а НЕ состояние: свежесть и доля
   линий по-прежнему говорят свои точки (жёлтая — устарело, без точки — нет
   данных). Иначе зелёная плитка при устаревшей сводке читалась бы «всё
   спокойно» (§4.0). */
.v7 .qt-radar{background:color-mix(in srgb,var(--success) 10%,var(--bg-card));border-color:color-mix(in srgb,var(--success) 32%,transparent)}
.v7 .qt-radar .qt-ic{color:color-mix(in srgb,var(--success) 78%,var(--text-primary));background:color-mix(in srgb,var(--success) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--success) 30%,transparent)}
.v7 .qt-badge{position:absolute;top:-3px;right:-3px;width:11px;height:11px;border-radius:50%;box-sizing:border-box;outline:2px solid var(--bg-card)}
.v7 .qt-tx{display:flex;flex-direction:column;gap:2px;min-width:0}
.v7 .qt-tx b{font:700 13px/1.2 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.v7 .qt-tx > span{font:500 10.5px/1.3 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v7 .qt-cov{display:flex;align-items:center;gap:5px}
.v7 .qt-cov i{width:6px;height:6px;border-radius:50%;flex:none;box-sizing:border-box}
@media (prefers-reduced-motion: reduce){.v7 .qt:active{transform:none}}
/* Самые узкие телефоны (320px): подписи чипов и плиток не входят — чуть мельче, а не многоточие. Стоит ПОСЛЕ правил .qt, иначе те перекрывают. */
@media (max-width:340px){.v7 .hero-chips{gap:4px}.v7 .hchip{font-size:9.5px}.v7 .qtools{gap:6px}.v7 .qt{gap:6px;padding:8px 6px}.v7 .qt-ic{width:32px;height:32px;border-radius:10px}.v7 .qt-tx b{font-size:11.5px}.v7 .qt-tx > span{font-size:9.5px}}
.v7 .hchip:active{transform:scale(.96)}
.v7 .hchip:hover{background:var(--bg-hover)}
/* секции */
.v7 section{margin-top:40px}
/* ЧТО именно случилось — текстом, не только цветом. Полоса появляется только
   при действующих предупреждениях; пустой рамки «всё спокойно» здесь быть не
   должно. Левая линия цветом опасности: она же отличает эту карточку от
   соседних, когда цвет точки в глаза не бросается. */
.v7 .alerts-now{margin:-14px 0 26px;padding:12px 14px;background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--danger);border-radius:16px}
.v7 .alerts-now ul{list-style:none;margin:0;padding:0}
.v7 .alerts-now li+li{border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent)}
.v7 .alerts-now .an-row{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:44px;padding:8px 0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;font:inherit;-webkit-tap-highlight-color:transparent}
.v7 .alerts-now li i{width:6px;height:6px;border-radius:50%;flex:none;margin-top:7px}
.v7 .alerts-now .an-t{display:block}
.v7 .alerts-now .an-clamp{display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.v7 .alerts-now .an-d{display:block;margin-top:6px;font-weight:400;color:var(--text-secondary);white-space:pre-line}
.v7 .alerts-now .an-chev{flex:none;margin-top:1px;color:var(--text-muted);transition:transform .2s ease}
.v7 .alerts-now .an-row[aria-expanded="true"] .an-chev{transform:rotate(180deg)}
.v7 .alerts-now i.sev-hi{background:var(--danger)}
.v7 .alerts-now i.sev-mid{background:var(--warning)}
.v7 .alerts-now i.sev-lo{background:var(--ocean)}
.v7 .alerts-now .an-tx{flex:1;font:500 12.5px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.v7 .alerts-now .an-st{display:block;margin-top:2px;font:400 10.5px/1.35 var(--font-outfit),system-ui,sans-serif;color:var(--text-muted)}
.v7 .alerts-now .an-go,.v7 .radar-panel .an-go{display:inline-flex;align-items:center;min-height:44px;font:600 9.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ocean);text-decoration:none}
/* Единый видимый фокус. Тонкий браузерный auto-контур на тёмном фото героя
   теряется, а без него человек с клавиатурой или switch-control не понимает,
   где находится. Не снимаем outline без замены. */
.v7 a:focus-visible,.v7 button:focus-visible,.v7 input:focus-visible{outline:2px solid var(--ocean);outline-offset:2px;border-radius:6px}
/* Подчинённая секция: продолжение предыдущей двери, а не новая — без
   заголовка и с меньшим отступом. Отступ ПОЛОЖИТЕЛЬНЫЙ: отрицательные -14px
   физически наезжали плитками на последний ряд предыдущей секции
   (полевой скриншот 01.08 — «Стихии» накрыли действия Кузьмича). */
.v7 section.sub{margin-top:14px}
.v7 .shead{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}
.v7 .shead h2{font:600 16px/1.2 var(--font-playfair),Georgia,serif;letter-spacing:-.02em}
.v7 .shead .line{flex:1;height:1px;background:color-mix(in srgb,var(--border) 55%,transparent)}
/* Ссылка заголовка — полноценная цель 44px (аудит 24.09, #127: была 10px в
   высоту шрифтом 9.5px). Видимая строка та же, зона нажатия — по высоте. */
.v7 .shead .all{display:inline-flex;align-items:center;min-height:44px;margin:-14px 0;font:600 11.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ocean);white-space:nowrap}
/* радар безопасности */
/* безопасность */
.v7 .volc{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.v7 .vchip{display:inline-flex;align-items:center;gap:6px;font:600 11px/1 var(--font-outfit),system-ui,sans-serif;border:1px solid var(--border);padding:7px 10px;border-radius:999px}
.v7 .vchip i{width:7px;height:7px;border-radius:50%}
.v7 .vchip small{font:400 9px/1 var(--fm);color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em}
/* Живая лента предупреждений — компактное окно ~4 строки с вертикальной прокруткой */
/* Курсор мыши на десктопе ставит бегущую строку на паузу, чтобы успеть прочитать.
   На тач-устройствах :hover не используем — там открытие/закрытие делает тап (см. .ticker-toggle). */
@media (hover:hover){.v7 .ticker.scroll:not(.open):hover .ticker-track{animation-play-state:paused}}
/* Развёрнутое состояние: полный читаемый список, без маски и без бегущей анимации,
   с обычной вертикальной прокруткой если не влезает. */
/* Сводка активной поездки: заголовок и день живут в герое, здесь — три
   плитки-входа. Плитка — работающая дверь, а не обещание. */
.v7 .tripstrip{margin-top:32px}
.v7 .tripstrip .ts-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.v7 .ts-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-height:96px;padding:12px;border-radius:16px;background:var(--bg-card);border:1px solid var(--border);text-decoration:none;color:var(--text-primary);transition:transform .13s ease}
.v7 .ts-tile:active{transform:scale(.97)}
.v7 .ts-tile svg{color:var(--ocean)}
.v7 .ts-tile b{font:700 12px/1.2 var(--font-outfit),system-ui,sans-serif;margin-top:auto}
.v7 .ts-tile span{font:500 9.5px/1.35 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
/* Действия безопасности — карточки, а не «поля формы»: заливка --plate +
   семантическая левая грань (МЧС=warning, офлайн-инструменты=tide, наблюдение=
   amber) + мягкая тень + подъём. Пунктир убран (читался как поле ввода).
   МЧС-строка была --danger намеренно («МЧС=danger»), но красный в дизайн-
   системе закреплён за SOS и ошибками: карточка-совет в красной рамке спорила
   с кнопкой СОС в шапке. Решение владельца 24.09 (развилка 2): --warning —
   это предупреждение «сделай заранее», а не авария. */
/* Секция #radar (якорь пилюли шапки): с 25.09 — полевые инструменты сеткой 2×2
   тех же плиток .qt, что ряд «Планировщик / Радар» выше. */
.v7 .radar-sec{margin-top:28px}
.v7 .radar-sec .alerts-now{margin:0 0 12px}
.v7 .fp-sec .more-tours{margin-top:14px}
.v7 .explore-sec{margin-top:32px}
.v7 .plates.explore .plate{width:62%;max-width:240px;padding-bottom:12px;color:inherit;text-decoration:none}
.v7 .plate.place .kind{display:block;padding:10px 12px 0;font:600 9.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted)}
.v7 .plate.place .row{padding-top:5px}
.v7 .plate.place .cap{display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.v7 .stools{margin:0}
/* Регистрация в МЧС — тёплая подложка (--warning): просьба, не тревога (--danger только SOS). */
.v7 .mchsline{background:color-mix(in srgb,var(--warning) 10%,var(--bg-card));border-color:color-mix(in srgb,var(--warning) 30%,transparent)}
.v7 .mchsline .qt-ic{color:color-mix(in srgb,var(--warning) 80%,var(--text-primary));background:color-mix(in srgb,var(--warning) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warning) 28%,transparent)}
/* «Пульс полуострова» — реальные сейсмособытия ритмом */
/* платы */
/* «Туры сезона» — первая карточка тура, первой под героем (П4б, 24.09).
   Компактная: фото 16:9 (было 10/11 — почти квадрат на весь экран), название
   и факты поверх нижней тени фото, CTA — под фото на сплошном фоне карточки.
   Текст на фото читается за счёт собственной нижней тени (.fp-shade). */
.v7 .firstpick{position:relative;display:block;text-decoration:none;color:#fff;border-radius:18px;overflow:hidden;background:var(--bg-card);border:1px solid var(--border)}
/* Верхняя привязка — та же причина, что у .plate .img: фото туров
   вертикальные, и центрирование срезает голову. */
.v7 .firstpick .fp-photo{position:relative;aspect-ratio:16/9;background:center top/cover no-repeat}
.v7 .firstpick .noimg{position:absolute;inset:0;background:linear-gradient(180deg,#7C9E88,#2E5140)}
.v7 .firstpick .fp-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,14,12,.08) 20%,rgba(10,14,12,.82) 92%)}
/* Бейдж — стекло поверх фото (контекст, §2), а не сплошная зелёная плашка:
   самым ярким пятном карточки должна быть цена и кнопка, а не он (#39). */
.v7 .firstpick .fp-badge{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;background:rgba(0,0,0,.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.15);color:#fff;font:600 11px/1 var(--font-outfit),system-ui,sans-serif}
.v7 .firstpick .fp-badge i{width:7px;height:7px;border-radius:50%;background:var(--success)}
@media (prefers-reduced-transparency:reduce){.v7 .firstpick .fp-badge{backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--bg-card);color:var(--text-primary);border-color:var(--border)}}
.v7 .firstpick .fp-over{position:absolute;left:0;right:0;bottom:0;padding:12px 14px;display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.v7 .firstpick .fp-over b{font:600 20px/1.15 var(--font-playfair),Georgia,serif;letter-spacing:-.015em;text-shadow:0 2px 14px rgba(0,0,0,.5);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.v7 .firstpick .fp-facts{align-self:stretch;display:flex;flex-direction:column;gap:2px;font:500 12.5px/1.3 var(--font-outfit),system-ui,sans-serif;color:rgba(255,255,255,.92)}
.v7 .firstpick .fp-facts em{font-style:normal;font-weight:700;font-size:15px;color:#fff}
.v7 .firstpick .fp-body{display:flex;align-items:center;gap:10px;padding:10px 12px}
.v7 .firstpick .fp-avail{flex:1;display:inline-flex;align-items:center;gap:6px;font:500 12px/1.3 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .firstpick .fp-avail svg,.v7 .plate .avail svg{flex:none;color:var(--warning)}
/* Текст на акценте — цвет фона страницы, как в каталоге: в тёмной теме белый
   на светлой лаве давал ~2.9:1. */
.v7 .firstpick .fp-cta{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:12px;background:var(--accent);color:var(--on-accent);font:700 13px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.02em}
/* scroll-padding-inline = отступ страницы (аудит 24.09, #38): без него точка
   привязки прижимала карточку к x=0, и текст начинался в 2px от кромки.
   position:relative — чтобы offsetLeft карточек считался от ленты (goPlate). */
.v7 .plates{position:relative;display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-inline:20px;scrollbar-width:none;margin:0 -20px;padding:0 20px}
.v7 .plates::-webkit-scrollbar{display:none}
.v7 .plate{flex:none;width:86%;max-width:360px;scroll-snap-align:start;display:flex;flex-direction:column;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
/* Точка остаётся 6px, а нажимается зона 26x44: сама точка рисуется вложенным
   ::after, кнопка вокруг неё прозрачная. Иначе переключатель плат — цель
   размером с крупинку, и в перчатке в него не попасть вовсе.
   Почему 26 по ширине, а не 44: соседние точки стоят в ряд, и зоны шириной
   44px либо налезли бы друг на друга (нажатие достаётся случайной), либо
   разнесли бы точки через весь экран. Ширина здесь ограничена шагом ряда, а
   высота — нет, и именно вертикального допуска пальцу не хватало. */
.v7 .pl-dots{display:flex;gap:0;justify-content:center;margin-top:0}
.v7 .pl-dots button{width:26px;height:44px;padding:0;border:0;background:none;display:grid;place-items:center;cursor:pointer}
.v7 .pl-dots button::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--border);transition:background .2s,transform .2s}
.v7 .pl-dots button.on::after{background:var(--accent);transform:scale(1.25)}
/* Кроп прижат к ВЕРХУ, а не по центру. Рамка здесь горизонтальная (4:3), а
   фотографии туров сплошь вертикальные: рыбак во весь рост с лососем. При
   центрировании кадр отрезал голову сверху и ноги снизу — на витрине оставалось
   безголовое туловище с рыбой (замечено владельцем 14.08 на «Летней рыбалке
   на чавычу»). Верхняя привязка режет только низ, а голова — то, по чему
   человека узнают. На горизонтальных фото вертикального запаса почти нет,
   поэтому им эта привязка ничего не меняет. */
.v7 .plate .img{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--bg-hover) center top/cover no-repeat}
.v7 .plate .img::after{content:"";position:absolute;inset:7px;border:1px solid rgba(244,244,240,.35);pointer-events:none}
.v7 .plate .noimg{position:absolute;inset:0;background:linear-gradient(180deg,#7C9E88,#2E5140)}
.v7 .plate .row{display:flex;align-items:baseline;gap:10px;padding:11px 12px 0}
.v7 .plate .row b{font:600 14px/1.25 var(--font-playfair),Georgia,serif;letter-spacing:-.015em}
.v7 .plate .cap{padding:5px 12px 0;font:400 12px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
/* Факты карточки: цена с единицей, длительность и оператор (#39/#122). */
.v7 .plate .facts{margin-top:9px;padding:9px 12px 0;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);display:flex;flex-direction:column;gap:4px}
.v7 .plate .facts .price{font:600 15px/1.2 var(--font-playfair),Georgia,serif;color:var(--text-primary)}
.v7 .plate .facts .price.muted{color:var(--text-secondary);font:500 12px/1.2 var(--font-outfit),system-ui,sans-serif}
.v7 .plate .facts .meta{font:500 12px/1.35 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .plate .cancel,.v7 .plate .avail{padding:5px 12px 0;font:400 12px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
/* Текст «сезон кончился» — --text-secondary: --warning (#D29922) на белой
   карточке даёт ~2.5:1 при 12px, ниже AA. Предупреждение несёт иконка. */
.v7 .plate .avail{display:flex;align-items:center;gap:6px}
.v7 .plate .buy{margin-top:auto;padding:12px}
/* CTA — кнопка 44px, 13px (была текст-ссылка 9.5px, 91×14px, #38/#127). */
.v7 .plate .buy-cta{display:flex;align-items:center;justify-content:center;min-height:44px;border-radius:10px;background:var(--accent);color:var(--on-accent);font:700 13px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.02em}
.v7 .arrivals{margin-top:18px;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);padding-top:11px;display:flex;gap:10px;align-items:baseline}
.v7 .arrivals .k{font:600 8.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:var(--text-muted);flex:none}
.v7 .arrivals .t{font:500 11.5px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
/* проводник */
.v7 .guide{border-left:2px solid var(--success);padding:2px 0 2px 18px}
.v7 .guide .gtop{display:flex;align-items:flex-start;gap:16px}
/* Медальон-гравюра: у Кузьмича не было лица — секция была цитатой без говорящего.
   Кремовый круг вшит в сам PNG, поэтому подложка не нужна ни в одной теме. */
.v7 .guide .face{width:72px;height:72px;flex:none;border-radius:50%;object-fit:cover}
.v7 .guide q{display:block;font:500 15px/1.5 var(--font-playfair),Georgia,serif;letter-spacing:-.01em;quotes:"«" "»"}
.v7 .guide .sig{margin-top:10px;display:flex;align-items:center;gap:10px}
.v7 .guide .sig .caps{font:600 10px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.22em;text-transform:uppercase;color:var(--text-secondary)}
.v7 .guide .sig .dot{width:4px;height:4px;border-radius:50%;background:var(--text-muted)}
.v7 .guide .sig .mono{font:400 9px/1 var(--fm);color:var(--text-muted)}
.v7 .guide .acts{margin-top:14px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
/* Цели 44px (#127). «Подобрать тур» — единственный переход к лид-форме,
   поэтому кнопка-заливка, а не подпись. */
.v7 .guide .acts a{display:inline-flex;align-items:center;min-height:44px;font:600 12px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--success);cursor:pointer}
.v7 .guide .acts a.golead{padding:0 16px;border-radius:12px;background:var(--accent);color:var(--on-accent);letter-spacing:.04em;text-transform:none;font-size:13px;font-weight:700}
/* стихии — сетка стеклянных плиток (стекло поверх цветного градиента, не сплошного фона) */
.v7 .elements{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.v7 .etile{position:relative;display:block;min-height:110px;border-radius:22px;overflow:hidden;isolation:isolate;
  box-shadow:0 6px 20px rgba(0,0,0,.14);transition:transform .18s,box-shadow .28s}
.v7 .etile::before{content:"";position:absolute;inset:0;z-index:-1}
.v7 .et-fire::before{background:radial-gradient(120% 90% at 30% 15%,#D46A3E 0%,#8A3B28 45%,#3E1710 100%)}
.v7 .et-snow::before{background:radial-gradient(120% 90% at 30% 15%,#DCEAF3 0%,#8FB4CC 45%,#3E5C72 100%)}
.v7 .et-ocean::before{background:radial-gradient(120% 90% at 30% 15%,#7FC1D2 0%,#2E8CA3 45%,#123E4C 100%)}
.v7 .et-therm::before{background:radial-gradient(120% 90% at 30% 15%,#E4CE9E 0%,#B4761F 48%,#5A3B0E 100%)}
.v7 .et-nature::before{background:radial-gradient(120% 90% at 30% 15%,#8FBE6E 0%,#4E8C5B 45%,#234A31 100%)}
.v7 .etile .glass{position:absolute;inset:7px;border-radius:16px;padding:13px 14px;display:flex;flex-direction:column;gap:3px;
  justify-content:flex-end;color:#fff;background:rgba(12,16,15,.24);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
  border:1px solid rgba(255,255,255,.20);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.v7 .etile .eicon{color:#fff;margin-bottom:auto;filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))}
.v7 .etile b{font:600 14.5px/1.15 var(--font-playfair),Georgia,serif;letter-spacing:-.01em;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.3)}
.v7 .etile .ecnt{font:400 9.5px/1 var(--fm);letter-spacing:.08em;color:rgba(255,255,255,.85)}
.v7 .etile:active{transform:scale(.97)}
/* подсветка-свечение по стихии */
.v7 .et-fire{box-shadow:0 8px 24px rgba(180,72,46,.42)}
.v7 .et-snow{box-shadow:0 8px 24px rgba(120,160,190,.42)}
.v7 .et-ocean{box-shadow:0 8px 24px rgba(46,140,163,.45)}
.v7 .et-therm{box-shadow:0 8px 24px rgba(180,118,31,.42)}
.v7 .et-nature{box-shadow:0 8px 24px rgba(78,140,91,.42)}
@media (hover:hover){
  .v7 .etile:hover{transform:translateY(-2px)}
  .v7 .et-fire:hover{box-shadow:0 12px 34px rgba(180,72,46,.62)}
  .v7 .et-snow:hover{box-shadow:0 12px 34px rgba(120,160,190,.62)}
  .v7 .et-ocean:hover{box-shadow:0 12px 34px rgba(46,140,163,.65)}
  .v7 .et-therm:hover{box-shadow:0 12px 34px rgba(180,118,31,.62)}
  .v7 .et-nature:hover{box-shadow:0 12px 34px rgba(78,140,91,.62)}
}
/* цифры */
.v7 .dataline{display:flex;overflow-x:auto;scrollbar-width:none}
.v7 .dataline::-webkit-scrollbar{display:none}
.v7 .dl{flex:none;padding:2px 20px 2px 0;margin-right:20px;border-right:1px solid color-mix(in srgb,var(--border) 55%,transparent)}
.v7 .dl:last-child{border-right:0;margin-right:0}
.v7 .dl .n{font:600 23px/1 var(--font-playfair),Georgia,serif;letter-spacing:-.02em}
.v7 .dl .t{margin-top:6px;font:600 8.5px/1.4 var(--font-outfit),system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--text-secondary);white-space:nowrap}
.v7 .dl.link .t{color:var(--ocean)}
/* На телефоне ряд цифр переносится (#128): скрытый горизонтальный скролл
   обрезал третью подпись («МАРШРУТОВ С РЕГИСТ…») без признака прокрутки. */
@media (max-width:480px){
  .v7 .dataline{flex-wrap:wrap;overflow:visible;row-gap:16px}
  .v7 .dl{flex:1 1 40%;border-right:0;margin-right:0;padding-right:12px}
  .v7 .dl .t{white-space:normal}
}
/* лид */
.v7 .lead{border:1px solid var(--border);padding:20px 18px}
.v7 .lead h3{font:600 20px/1.22 var(--font-playfair),Georgia,serif;letter-spacing:-.02em}
.v7 .lead h3 em{font-style:normal;font-weight:800;color:var(--accent)}
.v7 .lead p{margin-top:9px;font:400 11.5px/1.6 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .lead .chips{margin-top:14px;display:flex;flex-wrap:wrap;gap:7px}
.v7 .lead .chip{display:inline-flex;align-items:center;min-height:44px;font:600 9.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);border:1px solid var(--border);background:none;padding:0 13px;cursor:pointer;transition:.15s}
.v7 .lead .chip[aria-pressed="true"]{background:var(--text-primary);color:var(--bg-primary);border-color:var(--text-primary)}
.v7 .lead .field2{margin-top:14px;display:flex;flex-direction:column;gap:10px}
.v7 .lead .field2>input{border:1px solid var(--border);background:var(--bg-card);padding:14px 13px;font:500 13px/1 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary);outline:none}
.v7 .lead .field{display:flex;border:1px solid var(--border);background:var(--bg-card)}
/* min-width:0 (аудит 24.09, #3/#35): без него поле не ужималось ниже своей
   встроенной ширины, и «Отправить» выезжала за рамку (на 360px — за экран,
   scrollWidth 367). */
.v7 .lead .field input{flex:1;min-width:0;border:0;background:none;padding:14px 13px;font:500 13px/1 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary);outline:none}
.v7 .lead .field input::placeholder,.v7 .lead .field2>input::placeholder{color:var(--text-muted)}
.v7 .lead .field button{flex:none;min-height:44px;border:0;background:var(--accent);color:var(--on-accent);font:700 12px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;padding:0 16px;cursor:pointer}
.v7 .lead .field button:disabled{opacity:.6}
.v7 .lead .err{margin-top:6px;font:500 13px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--danger)}
/* Сноски формы — Outfit 12px --text-secondary (было JetBrains Mono 8.5px
   --text-muted, ~2.3:1). Ссылка на политику — --ocean с подчёркиванием:
   общее .v7 a{color:inherit} перебивало её до цвета текста. */
.v7 .lead .fine{margin-top:9px;font:400 12px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .lead .fine a{color:var(--ocean);text-decoration:underline;text-underline-offset:2px}
.v7 .lead .ok{margin-top:14px;padding:12px;border:1px solid color-mix(in srgb,var(--success) 40%,transparent);font:500 12px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--success);display:none}
.v7 .lead.sent .ok{display:block}
.v7 .lead.sent .field2,.v7 .lead.sent .chips,.v7 .lead.sent .fine,.v7 .lead.sent .err{display:none}
/* хабы */
.v7 .note{margin:40px 0 8px;padding-top:12px;border-top:1px solid var(--border);font:400 9px/1.7 var(--fm);color:var(--text-muted)}
/* навигация */
   padding кнопок: тач-зона заезжала в полосу системного жеста, и вкладка
   конкурировала со свайпом «домой». Держать в одном месте — иначе двойной
   запас: панель отодвигается, и кнопки внутри неё ещё раз. */
/* SOS — красный */
/* Инлайн-панель экстренной помощи (офлайн-стойкая, поверх главной) */
.v7 .emg{position:fixed;inset:0;z-index:100;background:var(--bg-primary);display:flex;flex-direction:column;animation:emgin .18s ease}
@keyframes emgin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.v7 .emg-top{display:flex;align-items:center;justify-content:space-between;padding:16px 18px calc(14px);border-bottom:1px solid var(--border);padding-top:calc(16px + env(safe-area-inset-top))}
.v7 .emg-top b{font:700 17px/1 var(--font-playfair),Georgia,serif;color:var(--text-primary)}
/* Закрыть экстренную панель — 44px. Это тот экран, где человеку хуже всего
   попадать в мелкое. */
.v7 .emg-x{width:44px;height:44px;display:grid;place-items:center;background:none;border:0;color:var(--text-secondary);cursor:pointer}
.v7 .emg-scroll{flex:1;overflow-y:auto;padding:16px 18px calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:18px}
.v7 .emg-lbl{display:flex;align-items:center;gap:6px;font:600 9px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--text-secondary)}
.v7 .emg-coord{display:flex;flex-direction:column;gap:8px}
.v7 .emg-cval{align-self:flex-start;display:inline-flex;align-items:center;gap:10px;font:600 20px/1 var(--fm);color:var(--text-primary);background:none;border:0;padding:0;cursor:pointer;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.v7 .emg-cval span{font:600 8.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--ocean)}
.v7 .emg-cwait{font:500 13px/1.3 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .emg-calls{display:flex;flex-direction:column;gap:9px}
.v7 .emg-call{display:flex;align-items:center;gap:12px;padding:13px 15px;border-radius:14px;border:1px solid var(--border);background:var(--bg-hover);color:var(--text-primary);text-decoration:none}
.v7 .emg-call .emg-ct{display:flex;flex-direction:column;gap:2px}
.v7 .emg-call .emg-ct b{font:600 15px/1 var(--font-outfit),system-ui,sans-serif}
.v7 .emg-call .emg-ct span{font:400 10px/1.2 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .emg-call-primary{background:var(--danger);border-color:transparent;color:#fff;padding:17px 18px}
.v7 .emg-call-primary .emg-ct b{font:800 26px/1 var(--font-playfair),Georgia,serif;letter-spacing:.02em}
.v7 .emg-call-primary .emg-ct span{color:rgba(255,255,255,.85)}
.v7 .emg-sms{display:block;text-align:center;padding:12px;border-radius:12px;border:1px dashed var(--border);color:var(--ocean);font:600 11px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;text-decoration:none}
.v7 .emg-protos{display:flex;flex-direction:column;gap:8px}
.v7 .emg-proto{border:1px solid var(--border);border-radius:12px;overflow:hidden}
.v7 .emg-phead{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:var(--bg-hover);border:0;cursor:pointer;text-align:left;font-family:var(--font-outfit),system-ui,sans-serif}
.v7 .emg-pt{display:flex;flex-direction:column;gap:3px}
.v7 .emg-pt b{font:600 13px/1 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.v7 .emg-pt span{font:400 10px/1.3 var(--font-outfit),system-ui,sans-serif;color:var(--danger)}
.v7 .emg-chev{color:var(--text-secondary);flex:none;transition:transform .2s ease}
.v7 .emg-chev-on{transform:rotate(180deg)}
.v7 .emg-steps{margin:0;padding:6px 16px 14px 30px;display:flex;flex-direction:column;gap:7px;list-style:decimal}
.v7 .emg-steps li{font:400 12px/1.45 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.v7 .emg-note{font:400 10.5px/1.4 var(--fm);color:var(--text-muted);text-align:center;margin:2px 0 0}
.v7 .sos:active{transform:scale(.94)}
/* ── ДЕСКТОП (перенос одобренного макета vedar-desktop-home, 02.08). ──────────
   Мобильную вёрстку НЕ трогаем: всё строго внутри брейкпоинтов. Проблема была
   в 480px-полоске посреди пустого экрана на компе (отзыв Ярослава). Лечение:
   широкий каркас + герой во весь размах + сетки используют ширину; а узкие по
   СМЫСЛУ блоки (поиск, планировщик, форма лида, карточка «подходит») держим в
   читаемой ширине по центру, а не растягиваем на 1080px. Визуальную приёмку
   на реальном десктопе делает владелец — из песочницы рендер не виден. */
@media (min-width:1024px){
  .v7{padding-bottom:0}
  .v7 .topbar .in{max-width:1080px;padding-left:32px;padding-right:32px}
  .v7 .wrap{max-width:1080px;padding:0 32px}
  .v7 .hero-in{max-width:1080px;padding:28px 32px 116px}
  .v7 .hero-photo{min-height:78vh;min-height:78dvh}
  .v7 .hero-photo h1{font-size:clamp(56px,5vw,78px);max-width:16ch}
  .v7 .hero-photo .sub{font-size:18px;max-width:52ch}
  .v7 .hb-mark{width:60px}
  .v7 section{margin-top:52px}
  /* Узкие по смыслу блоки — комфортная центрированная ширина, не весь экран */
  .v7 .hero-chips{max-width:760px;margin-left:auto;margin-right:auto}
  .v7 .qtools,.v7 .alerts-now{max-width:640px;margin-left:auto;margin-right:auto}
  .v7 .firstpick{max-width:520px;margin-left:auto;margin-right:auto}
  .v7 .guide{max-width:760px;margin-left:auto;margin-right:auto}
  .v7 .lead{max-width:680px;margin-left:auto;margin-right:auto}
  .v7 .lead .field2{flex-direction:row;flex-wrap:wrap}
  .v7 .lead .field2>input{flex:1;min-width:200px}
  .v7 .lead .field{flex:2;min-width:260px}
    /* Сетки используют ширину: стихии в 3 колонки (5 плиток ложатся без дыры —
     последняя span 2), платы показывают по три, цифры по центру */
  .v7 .elements{grid-template-columns:repeat(3,1fr)}
  .v7 .plate{width:320px}
  .v7 .dataline{justify-content:center;gap:8px}
  .v7 .shead h2{font-size:22px}
}
@media (min-width:1280px){
  .v7 .topbar .in,.v7 .wrap,.v7 .hero-in{max-width:1160px}
}
`;
