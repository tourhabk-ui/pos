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

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Flame, Snowflake, Waves, Droplets, Trees, Sun, Moon, Phone, X, ChevronDown, MapPin, User, type LucideIcon } from 'lucide-react';
import BottomNav from '@/components/shared/BottomNav';

// P0-3b: реализации радара/ленты/пульса переехали в components/safety/LiveStatus.
// Реэкспорт — обратная совместимость импортов (home-alerts-ticker.test.ts и
// любые внешние потребители формул подписи).
export { alertStamp, clip } from '@/components/safety/LiveStatus';
import type { HomeV8Data, SafetyAlert } from './data';
import { EMERGENCY_NUMBERS } from '@/lib/safety/emergency-numbers';
import { INTENT_CHIPS } from '@/lib/home/intent-chips';
import { safetyPill } from '@/lib/home/safety-pill';
import { dataFreshness, freshnessDot } from '@/lib/home/data-freshness';
import { TrailReportSheet } from '@/components/homepage/TrailReportSheet';
import EmergencyAction from '@/components/shared/EmergencyAction';

const ELEMENT_ICON: Record<string, LucideIcon> = {
  fire: Flame, snow: Snowflake, ocean: Waves, therm: Droplets, nature: Trees,
};

const CHIPS = ['Вулканы', 'Рыбалка', 'Медведи', 'Океан', 'Термы', 'Хели-ски'];

const ACC_LABEL: Record<string, string> = { red: 'красный', orange: 'оранжевый', yellow: 'жёлтый' };
const ACC_VAR: Record<string, string> = { red: 'var(--danger)', orange: 'var(--accent)', yellow: 'var(--warning)' };

function fmtPrice(n: number | null): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
}

interface ActiveTrip {
  id: string;
  title: string;
  progress: { day: number | null; total: number | null; phase: 'before' | 'during' | 'after' | 'unknown' };
}

export default function HomeV8Client({ data }: { data: HomeV8Data }) {
  const { safety, seismic, radar, plates, feed, stats, elements } = data;
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [chips, setChips] = useState<Record<string, boolean>>({});
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plateIdx, setPlateIdx] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const [intent, setIntent] = useState('');
  const leadRef = useRef<HTMLDivElement | null>(null);
  const platesRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  // Состояние обстановки словом. Дроби нет: районного статуса в базе не
  // существует, а знаменатель по 763 точкам читается как шум — см. safety-pill.
  const pill = safetyPill({ activeCount: safety.activeCount, maxSeverity: safety.maxSeverity });

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

  // Поиск ведёт в тот же SSR-листинг, который турист увидит по любой ссылке
  // каталога: одна выдача, а не отдельная «поисковая» ветка со своей правдой.
  const submitIntent = (e: FormEvent) => {
    e.preventDefault();
    const q = intent.trim();
    router.push(q ? `/routes?q=${encodeURIComponent(q)}` : '/routes');
  };

  // Тема — ЕДИНЫЙ механизм платформы (data-theme + класс .dark + kh-theme),
  // никакого параллельного data-v7theme/v8-theme (снят редизайном 31.07:
  // главная жила в собственной теме, и переключатель на ней не влиял на
  // остальные страницы — а глобальный не влиял на главную).
  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') setTheme(t);
  }, []);

  const chooseTheme = (t: 'light' | 'dark') => {
    setTheme(t);
    const r = document.documentElement;
    r.setAttribute('data-theme', t);
    r.classList.toggle('dark', t === 'dark');
    try { localStorage.setItem('kh-theme', t); } catch { /* приватный режим */ }
  };

  // Карусель «Куда сегодня»: автопрокрутка + точки, пауза при касании.
  useEffect(() => {
    const c = platesRef.current;
    if (!c || plates.length < 2) return;
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stride = () => {
      const first = c.firstElementChild as HTMLElement | null;
      return first ? first.getBoundingClientRect().width + 14 : c.clientWidth;
    };
    let idx = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let pauseTimer: ReturnType<typeof setTimeout>;
    const go = (i: number) => {
      idx = (i + plates.length) % plates.length;
      c.scrollTo({ left: idx * stride(), behavior: rm ? 'auto' : 'smooth' });
      setPlateIdx(idx);
    };
    const onScroll = () => {
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        const i = Math.round(c.scrollLeft / stride());
        if (i !== idx) { idx = i; setPlateIdx(i); }
      }, 90);
    };
    const start = () => { if (!rm && !timer) timer = setInterval(() => go(idx + 1), 5000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onUp = () => { setTimeout(start, 8000); };
    c.addEventListener('scroll', onScroll, { passive: true });
    c.addEventListener('pointerdown', stop, { passive: true });
    c.addEventListener('pointerup', onUp);
    start();
    return () => {
      stop(); clearTimeout(pauseTimer);
      c.removeEventListener('scroll', onScroll);
      c.removeEventListener('pointerdown', stop);
      c.removeEventListener('pointerup', onUp);
    };
  }, [plates.length]);

  const goPlate = (i: number) => {
    const c = platesRef.current;
    if (!c) return;
    const first = c.firstElementChild as HTMLElement | null;
    const stride = first ? first.getBoundingClientRect().width + 14 : c.clientWidth;
    c.scrollTo({ left: i * stride, behavior: 'smooth' });
    setPlateIdx(i);
  };

  const jumpToLead = () => {
    leadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const submitLead = async () => {
    setErr(null);
    if (name.trim().length < 2) { setErr('Укажите имя'); return; }
    if (phone.trim().length < 7) { setErr('Укажите телефон или Telegram'); return; }
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

      {/* шапка */}
      <div className="topbar"><div className="in">
        <span className="brand">Ведар</span>
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
            выглядела рабочей и не делала ничего. Настоящий поиск теперь строкой
            в герое, прямо под шапкой — и место в узкой шапке освободилось. */}
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

      {/* ГЕРОЙ — фото-первый */}
      <header className="hero-photo" style={{ backgroundImage: `linear-gradient(180deg, rgba(10,14,12,.15) 0%, rgba(10,14,12,.55) 62%, rgba(10,14,12,.82) 100%), url('${heroImg}')` }}>
        <div className="hero-in">
          <div className="dateline"><span>Камчатка · живая сводка</span></div>
          <h1>Полуостров,<br />прочитанный <em>сегодня</em></h1>
          <p className="sub">Маршруты, безопасность и реальные туры проверенных операторов — в одном месте.</p>

          {/* Одно действие вместо трёх равных кнопок. Каталог, планировщик и
              Кузьмич никуда не делись: каталог — это и есть выдача поиска,
              планировщик живёт в секции «Собрать поездку» и в чипе «На 3–5
              дней», Кузьмич — в своей секции и в таб-баре. Три равные кнопки
              заставляли выбирать инструмент раньше, чем человек выбрал поездку. */}
          <form className="hero-find" onSubmit={submitIntent} role="search">
            {/* Медальон-гравюра вместо лупы: поиск на Ведаре — это не «найти
                строку», а «спросить у того, кто знает край». Марка из набора
                владельца, тот же резец, что у портрета Кузьмича. */}
            <img
              className="hfb"
              src="/images/brand/bear-64.webp"
              srcSet="/images/brand/bear-64.webp 64w, /images/brand/bear-128.webp 128w, /images/brand/bear-192.webp 192w"
              sizes="30px"
              width={30}
              height={30}
              alt=""
              aria-hidden
              loading="eager"
              decoding="async"
            />
            <input
              type="search"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Куда хотите поехать?"
              aria-label="Поиск по маршрутам и местам"
              enterKeyHint="search"
            />
            <button type="submit">Найти</button>
          </form>
          <div className="hero-chips">
            {INTENT_CHIPS.map((c) => (
              <Link key={c.key} href={c.href} className="hchip">{c.label}</Link>
            ))}
          </div>
          {safety.volcanoes[0] && (
            <div className="kvert">
              <i style={{ background: ACC_VAR[safety.volcanoes[0].acc] }} />
              KVERT: {ACC_LABEL[safety.volcanoes[0].acc] ?? safety.volcanoes[0].acc} · {safety.volcanoes[0].name}
            </div>
          )}
        </div>
      </header>

      <div className="wrap">

        {/* LIVE — обстановка одной строкой. Это не радар: радар показывает
            подробности, а здесь ответ на вопрос «можно ли вообще сегодня».
            Свежесть обязательна и показывается тремя состояниями: «спокойно»
            по позавчерашним данным и «спокойно» по свежим — разные
            утверждения, и человек должен видеть, какое ему показали. */}
        <section className="live">
          <span
            className="lv-dot"
            style={freshnessDot(fresh.state)
              ? { background: freshnessDot(fresh.state) as string }
              : { border: '1px solid var(--text-muted)' }}
          />
          <span className="lv-txt">{fresh.label}</span>
          <Link className="lv-go" href="/safety">Карта сегодня →</Link>
        </section>

        {/* 0. ПЕРВЫЙ РЕЗУЛЬТАТ — доказательство, что подбор работает.
            Никаких «совпадает с вашим запросом»: запроса у гостя ещё не было.
            Показываем только то, что действительно знаем про этот тур. */}
        {plates[0] && (
          <section>
            <div className="shead"><h2>Подходит вам сейчас</h2><span className="line" /><Link className="all" href="/routes">Все</Link></div>
            <Link href={plates[0].kind === 'tour' ? `/marketplace/tours/${plates[0].id}` : `/routes/${plates[0].id}`} className="firstpick">
              <div className="fp-img" style={plates[0].imageUrl ? { backgroundImage: `url('${plates[0].imageUrl}')` } : undefined}>
                {!plates[0].imageUrl && <span className="noimg" />}
              </div>
              <div className="fp-body">
                <b>{plates[0].title}</b>
                {plates[0].description && <span className="fp-cap">{plates[0].description}</span>}
                <span className="fp-facts">
                  {fmtPrice(plates[0].priceFrom)
                    ? <em>от {fmtPrice(plates[0].priceFrom)}</em>
                    : <em className="muted">Цена по запросу</em>}
                  {plates[0].kind === 'tour' && <span>тур оператора</span>}
                </span>
              </div>
            </Link>
          </section>
        )}

        {/* АКТИВНАЯ ПОЕЗДКА — только при подтверждённом режиме (см. выше).
            Плитки — только работающие входы: навигатор, радар, офлайн-карта.
            Никаких «следующая точка N» — связи день→точка в данных нет. */}
        {trip && (
          <section className="tripstrip" aria-label="Активная поездка">
            <div className="ts-head">
              <span className="ts-cap">{trip.progress.phase === 'during' ? 'Вы в поездке' : 'Скоро в путь'}</span>
              <b className="ts-title">{trip.title}</b>
              {trip.progress.phase === 'during' && trip.progress.day != null && trip.progress.total != null && (
                <span className="ts-day">День {trip.progress.day} из {trip.progress.total}</span>
              )}
              {trip.progress.phase === 'before' && trip.progress.total != null && (
                <span className="ts-day">{trip.progress.total} дн. маршрута впереди</span>
              )}
            </div>
            <div className="ts-links">
              <a href="/planning?mode=trail">Навигатор</a>
              <Link href="/safety#radar">Радар</Link>
              <Link href="/map">Офлайн-карта</Link>
            </div>
          </section>
        )}

        {/* I. РАДАР БЕЗОПАСНОСТИ — реальные опасности вокруг тебя */}
        <section id="radar">
          <div className="shead"><h2>Радар обстановки</h2><span className="line" /><Link className="all" href="/safety">Спасатель</Link><Link className="all" href="/map">Карта</Link></div>

          {/* P0-3b: тяжёлая реализация радара живёт на /safety#radar —
              главная даёт статус (пилюля сверху) и дорогу к подробностям.
              Плитка, не виджет: главная не дублирует спасательский экран. */}
          <Link href="/safety#radar" className="protoline">
            Радар обстановки: сейсмика, вулканы КВЕРТ, наблюдения туристов
            <b>смотреть вживую →</b>
          </Link>

          <Link href="/register" className="mchsline">
            <b>Зарегистрируй маршрут в МЧС заранее</b>
            <span>Бесплатно. С гидом или сам — спасателям это спасает жизни →</span>
          </Link>

          <Link href="/safety/offline" className="protoline">
            Что делать при ЧП: медведь · холод · вулкан · потерялся
            <b>работает без сети →</b>
          </Link>

          {/* Навигатор — жёсткая ссылка (не Next Link): чтобы офлайн грузилась
              закэшированная страница, а не заглушка «Нет соединения». */}
          <a href="/planning?mode=trail" className="protoline">
            Навигатор по маршруту: компас до точки, высота, трек
            <b>работает без сети →</b>
          </a>

          <button type="button" className="reportbtn" onClick={() => setReportOpen(true)}>
            Сообщить о наблюдении <span>медведь · лавина · состояние тропы →</span>
          </button>

        </section>

        {/* ИССЛЕДОВАТЬ — одна дверь вместо трёх.
            Было: «Куда сегодня», «Стихии» и «Разделы» — три самостоятельные
            секции, ведущие в один и тот же каталог. Это не богатство выбора, а
            нерешительность: человеку предлагали выбрать между тремя входами в
            одну комнату. Теперь один вход и три глубины: конкретные карточки →
            выбор по стихии → разделы платформы. */}
        {plates.length > 0 && (
          <section>
            <div className="shead"><h2>Исследовать</h2><span className="line" /><Link className="all" href="/routes">Весь каталог</Link></div>
            <div className="plates" ref={platesRef}>
              {plates.map((p) => {
                const href = p.kind === 'tour' ? `/marketplace/tours/${p.id}` : `/routes/${p.id}`;
                const price = fmtPrice(p.priceFrom);
                return (
                  <figure className="plate" key={p.id}>
                    <Link href={href}><div className="img" style={p.imageUrl ? { backgroundImage: `url('${p.imageUrl}')` } : undefined}>
                      {!p.imageUrl && <span className="noimg" />}
                    </div></Link>
                    <div className="row"><b>{p.title}</b></div>
                    {p.description && <div className="cap">{p.description}</div>}
                    <div className="buy">
                      {price ? <span className="price">от {price}</span> : <span className="price muted">Цена по запросу</span>}
                      <Link href={href}>{p.kind === 'tour' ? 'Смотреть тур' : 'Открыть'}</Link>
                    </div>
                  </figure>
                );
              })}
            </div>
            {plates.length > 1 && (
              <div className="pl-dots">
                {plates.map((_, i) => (
                  <button key={i} className={i === plateIdx ? 'on' : ''} aria-label={`Плата ${i + 1}`} onClick={() => goPlate(i)} />
                ))}
              </div>
            )}
            {feed.length > 0 && (
              <div className="arrivals"><span className="k">Журнал</span><span className="t">{feed[0].text}</span></div>
            )}
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
              <a className="lead" onClick={(e) => { e.preventDefault(); jumpToLead(); }} href="#lead">Подобрать тур</a>
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
                      <span className="ecnt">{el.count} мест</span>
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
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Как вас зовут" aria-label="Имя" />
              <div className="field">
                <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Телефон или Telegram" aria-label="Контакт" />
                <button onClick={submitLead} disabled={sending}>{sending ? '…' : 'Отправить'}</button>
              </div>
            </div>
            {err && <div className="err">{err}</div>}
            <div className="fine">Данные уходят только операторам по вашему запросу. Без спама.</div>
            <div className="ok">Заявка принята. Кузьмич собирает подборку — оператор ответит в течение дня.</div>
          </div>
        </section>

        {/* Третий слой: разделы платформы. Тоже был отдельной дверью в каталог. */}
        <section className="sub">
          <div className="hubline">
            <Link href="/routes">Туристам</Link><Link href="/routes?activity_type=fishing">Рыбалка</Link>
            <Link href="/hub">Операторам</Link><Link href="/guides">Гидам</Link>
            <Link href="/accommodations">Жильё</Link><Link href="/gear">Снаряжение</Link><Link href="/transfers">Трансферы</Link>
          </div>
        </section>

      </div>

      {/* Сообщить о наблюдении (trail_reports) — восстановлено на v8 после свапа
          мобильной Главной; шторка сама рендерит оверлей. */}
      <TrailReportSheet open={reportOpen} onClose={() => setReportOpen(false)} />

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
    steps: [
      'Остановись. Говори спокойным низким голосом — покажи, что ты человек.',
      'Медленно отступай боком, не поворачивайся спиной.',
      'Подними руки — выгляди крупнее. Антизверь наготове.',
      'Приближается — шуми, бей в кастрюлю, кричи.',
      'Нападение: бей в нос и глаза. Не ложись — только активное сопротивление.',
      'Медведица с медвежатами опаснее всего — уходи немедленно.',
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
/* flex-wrap — страховка бюджета ширины (#893): если содержимое шапки не
   помещается (длинное состояние пилюли, узкий экран), строка переносится,
   а не уезжает за край. Переполнение прячет действие, вторая строка — нет.
   Бюджет пересчитан после смены шрифтов на Playfair/Outfit и композиции
   #887/#892 — числа в scripts/measure-header-budget.mjs. */
.v7 .topbar .in{max-width:480px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;row-gap:6px}
.v7 .topbar .brand{font:700 12px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.42em;text-transform:uppercase;padding-left:.42em}
/* Бренд уступает место первым (решение владельца 2026-07-30: единственный
   элемент шапки, который ничего не сообщает и никуда не ведёт). Порог 427px
   выведен ИЗМЕРЕНИЕМ (scripts/measure-header-budget.mjs, реальный Inter,
   31.07): бренд 72.63 + худшее короткое состояние пилюли «Опасность» 93.77 +
   SOS 72.53 + иконки 88 + зазоры 60 + поля 40 = 426.93. Ниже — однострочная
   шапка без бренда; длинное «5+ предупреждений» переносится страховкой
   flex-wrap, а не определяет порог. */
@media (max-width:426px){.v7 .topbar .brand{display:none}}
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
.v7 .pill{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:30px;padding:0 10px;border-radius:999px;text-decoration:none;font:600 10.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.02em;color:var(--text-primary);border:1px solid var(--border);white-space:nowrap;transition:background .2s}
.v7 .pill i{width:7px;height:7px;border-radius:50%;flex:none}
.v7 .pill-calm i{background:var(--success)}
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
.v7 .hero-photo{position:relative;min-height:60vh;min-height:60dvh;background-size:cover;background-position:center;display:flex;align-items:flex-end;color:#fff}
@media (min-width:768px){.v7 .hero-photo{min-height:70vh;min-height:70dvh}}
.v7 .hero-in{max-width:480px;margin:0 auto;padding:0 20px 22px;width:100%;text-align:center}
.v7 .hero-photo .dateline{display:flex;align-items:center;gap:12px;justify-content:center;color:rgba(255,255,255,.75)}
.v7 .hero-photo .dateline::before,.v7 .hero-photo .dateline::after{content:"";flex:0 0 30px;height:1px;background:rgba(255,255,255,.4)}
.v7 .hero-photo .dateline span{font:400 9px/1 var(--fm);letter-spacing:.18em;text-transform:uppercase}
.v7 .hero-photo h1{margin-top:12px;font:600 30px/1.14 var(--font-playfair),Georgia,serif;letter-spacing:-.03em;text-shadow:0 2px 24px rgba(0,0,0,.4)}
.v7 .hero-photo h1 em{font-style:normal;font-weight:800;color:var(--accent)}
.v7 .hero-photo .sub{margin:10px auto 0;font:500 13px/1.55 var(--font-outfit),system-ui,sans-serif;color:rgba(255,255,255,.88);max-width:32ch}
/* поиск и чипы в герое — одно действие вместо трёх равных кнопок.
   Стекло здесь законно: подложка — фотография, а не сплошной фон. */
.v7 .hero-find{margin-top:18px;width:100%;max-width:420px;display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:16px;backdrop-filter:blur(10px);background:rgba(10,14,12,.42);border:1px solid rgba(255,255,255,.18)}
.v7 .hero-find .hfb{width:30px;height:30px;flex:none;border-radius:50%;object-fit:cover}
/* align-self:stretch — рамка поля выглядела крупной, а нажималась полоска
   16.8px: сам input не заполнял её по высоте, и промах по вертикали попадал
   мимо фокуса. Теперь input занимает всю высоту рамки, которую видит человек. */
.v7 .hero-find input{flex:1;min-width:0;align-self:stretch;min-height:44px;background:none;border:0;outline:none;color:#fff;font:400 14px/1.2 var(--font-outfit),system-ui,sans-serif}
.v7 .hero-find input::placeholder{color:rgba(255,255,255,.62)}
.v7 .hero-find button{flex:none;min-height:44px;padding:0 14px;border:0;border-radius:11px;background:var(--accent);color:#fff;font:700 10.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:transform .13s}
.v7 .hero-find button:active{transform:scale(.96)}
.v7 .hero-chips{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;max-width:420px}
.v7 .hchip{min-height:44px;display:inline-flex;align-items:center;padding:0 13px;border-radius:999px;text-decoration:none;color:#fff;font:600 11.5px/1 var(--font-outfit),system-ui,sans-serif;backdrop-filter:blur(10px);background:rgba(10,14,12,.34);border:1px solid rgba(255,255,255,.16);transition:transform .13s ease,background .2s ease}
.v7 .hchip:active{transform:scale(.96)}
.v7 .hchip:hover{background:rgba(10,14,12,.52)}
.v7 .hero-photo .kvert{margin-top:12px;display:inline-flex;align-items:center;gap:8px;font:400 9.5px/1 var(--fm);letter-spacing:.08em;color:rgba(255,255,255,.85)}
.v7 .hero-photo .kvert i{width:7px;height:7px;border-radius:50%}
/* секции */
.v7 section{margin-top:40px}
.v7 .live{display:flex;align-items:center;gap:10px;padding:11px 14px;margin-bottom:26px;border:1px solid var(--border);border-radius:12px}
.v7 .live .lv-dot{width:8px;height:8px;border-radius:50%;flex:none;box-sizing:border-box}
.v7 .live .lv-txt{flex:1;font:500 12px/1.2 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.v7 .live .lv-go{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;font:600 9.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ocean);text-decoration:none;white-space:nowrap}
/* Единый видимый фокус. Тонкий браузерный auto-контур на тёмном фото героя
   теряется, а без него человек с клавиатурой или switch-control не понимает,
   где находится. Не снимаем outline без замены. */
.v7 a:focus-visible,.v7 button:focus-visible,.v7 input:focus-visible{outline:2px solid var(--ocean);outline-offset:2px;border-radius:6px}
/* Подчинённая секция: продолжение предыдущей двери, а не новая. Поэтому без
   собственного заголовка и с меньшим отступом сверху. */
.v7 section.sub{margin-top:-14px}
.v7 .shead{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}
.v7 .shead h2{font:600 16px/1.2 var(--font-playfair),Georgia,serif;letter-spacing:-.02em}
.v7 .shead .line{flex:1;height:1px;background:color-mix(in srgb,var(--border) 55%,transparent)}
.v7 .shead .all{font:600 9.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ocean)}
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
/* Полоса активной поездки: спокойная карточка, день — единственный акцент. */
.v7 .tripstrip{margin:14px 0 4px;padding:12px 14px;border-radius:14px;background:var(--bg-card);border:1px solid var(--border);border-left:3px solid var(--accent)}
.v7 .tripstrip .ts-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.v7 .tripstrip .ts-cap{font:600 9px/1 var(--fm);letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
.v7 .tripstrip .ts-title{font:700 14px/1.25 var(--font-playfair),Georgia,serif;color:var(--text-primary)}
.v7 .tripstrip .ts-day{font:700 11px/1 var(--font-outfit),system-ui,sans-serif;color:var(--accent);margin-left:auto;white-space:nowrap}
.v7 .tripstrip .ts-links{display:flex;gap:10px;margin-top:1px}
.v7 .tripstrip .ts-links a{font:600 11px/1 var(--font-outfit),system-ui,sans-serif;color:var(--ocean);min-height:44px;padding:0 4px;display:inline-flex;align-items:center}
/* Действия безопасности — карточки, а не «поля формы»: заливка --plate +
   семантическая левая грань (МЧС=danger, офлайн-инструменты=tide, наблюдение=
   amber) + мягкая тень + подъём. Пунктир убран (читался как поле ввода). */
.v7 .mchsline{display:flex;flex-direction:column;gap:2px;margin-top:14px;padding:12px 14px 12px 15px;border-radius:14px;text-decoration:none;background:color-mix(in srgb,var(--danger) 9%,transparent);border:1px solid color-mix(in srgb,var(--danger) 22%,transparent);border-left:3px solid color-mix(in srgb,var(--danger) 48%,transparent)}
.v7 .mchsline b{font:700 12px/1.3 var(--font-playfair),Georgia,serif;color:var(--text-primary)}
.v7 .mchsline span{font:500 10px/1.35 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .mchsline:active{transform:scale(.99)}
.v7 .protoline{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;margin-top:8px;padding:11px 14px 11px 15px;border-radius:12px;text-decoration:none;background:var(--bg-hover);border:1px solid color-mix(in srgb,var(--border) 55%,transparent);border-left:3px solid color-mix(in srgb,var(--ocean) 68%,transparent);box-shadow:0 1px 3px rgba(0,0,0,.05);font:500 10.5px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary);transition:transform .2s ease,box-shadow .2s ease}
.v7 .protoline b{font:700 10.5px/1 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary)}
.v7 .protoline:hover{transform:translateY(-1px);box-shadow:0 5px 14px -5px rgba(0,0,0,.14)}
.v7 .protoline:active{transform:scale(.99)}
.v7 .reportbtn{display:block;width:100%;text-align:left;margin-top:8px;padding:11px 14px 11px 15px;border-radius:12px;background:var(--bg-hover);border:1px solid color-mix(in srgb,var(--border) 55%,transparent);border-left:3px solid color-mix(in srgb,var(--warning) 62%,transparent);box-shadow:0 1px 3px rgba(0,0,0,.05);cursor:pointer;font:600 10.5px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary);font-family:var(--font-outfit),system-ui,sans-serif;transition:transform .2s ease,box-shadow .2s ease}
.v7 .reportbtn span{color:var(--text-secondary);font-weight:500}
.v7 .reportbtn:hover{transform:translateY(-1px);box-shadow:0 5px 14px -5px rgba(0,0,0,.14)}
.v7 .reportbtn:active{transform:scale(.99)}
/* «Пульс полуострова» — реальные сейсмособытия ритмом */
/* платы */
/* первый результат подбора — крупнее платы, но той же породы */
.v7 .firstpick{display:block;text-decoration:none;color:inherit;border:1px solid var(--border);background:var(--bg-hover);overflow:hidden}
.v7 .firstpick .fp-img{position:relative;aspect-ratio:16/9;background:var(--bg-hover) center/cover no-repeat}
.v7 .firstpick .noimg{position:absolute;inset:0;background:linear-gradient(180deg,#7C9E88,#2E5140)}
.v7 .firstpick .fp-body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:7px}
.v7 .firstpick .fp-body b{font:600 17px/1.25 var(--font-playfair),Georgia,serif;letter-spacing:-.01em}
.v7 .firstpick .fp-cap{font:400 12.5px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .firstpick .fp-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;font:400 11.5px/1 var(--fm);color:var(--text-secondary)}
.v7 .firstpick .fp-facts em{font-style:normal;font-weight:700;color:var(--text-primary)}
.v7 .firstpick .fp-facts em.muted{font-weight:400;color:var(--text-secondary)}
.v7 .plates{display:flex;gap:14px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;margin:0 -20px;padding:0 20px}
.v7 .plates::-webkit-scrollbar{display:none}
.v7 .plate{flex:none;width:86%;max-width:360px;scroll-snap-align:start}
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
.v7 .plate .img{position:relative;aspect-ratio:4/3;overflow:hidden;background:var(--bg-hover) center/cover no-repeat}
.v7 .plate .img::after{content:"";position:absolute;inset:7px;border:1px solid rgba(244,244,240,.35);pointer-events:none}
.v7 .plate .noimg{position:absolute;inset:0;background:linear-gradient(180deg,#7C9E88,#2E5140)}
.v7 .plate .row{display:flex;align-items:baseline;gap:10px;padding:11px 2px 0}
.v7 .plate .row b{font:600 14px/1.25 var(--font-playfair),Georgia,serif;letter-spacing:-.015em}
.v7 .plate .cap{padding:5px 2px 0;font:400 11px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--text-secondary)}
.v7 .plate .buy{margin-top:9px;padding:9px 2px 0;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);display:flex;align-items:baseline;gap:10px}
.v7 .plate .buy .price{font:600 14px/1 var(--font-playfair),Georgia,serif}
.v7 .plate .buy .price.muted{color:var(--text-muted);font-weight:500;font-size:12px}
.v7 .plate .buy a{margin-left:auto;font:700 9.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid color-mix(in srgb,var(--accent) 45%,transparent);padding-bottom:3px}
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
.v7 .guide .acts{margin-top:14px;display:flex;gap:22px;align-items:center}
.v7 .guide .acts a{font:600 10px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--success);border-bottom:1px solid color-mix(in srgb,var(--success) 35%,transparent);padding-bottom:3px;cursor:pointer}
.v7 .guide .acts a.lead{color:var(--accent);border-bottom-color:color-mix(in srgb,var(--accent) 45%,transparent)}
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
.v7 .lead .field input{flex:1;border:0;background:none;padding:14px 13px;font:500 13px/1 var(--font-outfit),system-ui,sans-serif;color:var(--text-primary);outline:none}
.v7 .lead .field input::placeholder,.v7 .lead .field2>input::placeholder{color:var(--text-muted)}
.v7 .lead .field button{border:0;background:var(--accent);color:#fff;font:700 10px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;padding:0 18px;cursor:pointer}
.v7 .lead .field button:disabled{opacity:.6}
.v7 .lead .err{margin-top:10px;font:500 11px/1.4 var(--font-outfit),system-ui,sans-serif;color:var(--danger)}
.v7 .lead .fine{margin-top:9px;font:400 8.5px/1.5 var(--fm);color:var(--text-muted)}
.v7 .lead .ok{margin-top:14px;padding:12px;border:1px solid color-mix(in srgb,var(--success) 40%,transparent);font:500 12px/1.5 var(--font-outfit),system-ui,sans-serif;color:var(--success);display:none}
.v7 .lead.sent .ok{display:block}
.v7 .lead.sent .field2,.v7 .lead.sent .chips,.v7 .lead.sent .fine,.v7 .lead.sent .err{display:none}
/* хабы */
.v7 .hubline{display:flex;flex-wrap:wrap;gap:12px 24px}
.v7 .hubline a{font:600 10.5px/1 var(--font-outfit),system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--text-secondary);padding-bottom:4px;border-bottom:1px solid transparent}
.v7 .hubline a:active{color:var(--text-primary);border-bottom-color:var(--text-primary)}
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
`;
