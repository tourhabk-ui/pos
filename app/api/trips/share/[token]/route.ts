import { NextRequest, NextResponse } from 'next/server';
import { topToursByActivity, toursByIds, type TopTour } from '@/lib/tours/top-tour-by-activity';
import { readSharedPlan } from '@/lib/trips/shared-plan';
import type { TripDayAvailability } from '@/lib/trips/day-availability';
import { readDayAvailability, readDayForecast, type TripDayForecast } from '@/lib/trips/day-fresh';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ success: false, error: 'Неверный токен' }, { status: 400 });
  }

  try {
    // Опубликованная поездка или черновик плана Кузьмича/MCP (#2225) — одно
    // правило с GPX и страницей (lib/trips/shared-plan).
    const read = await readSharedPlan(token);
    if (read.kind === 'failed') {
      return NextResponse.json({ success: false, error: 'План сейчас не прочитался — попробуйте чуть позже' }, { status: 503 });
    }
    if (read.kind === 'missing') {
      return NextResponse.json({ success: false, error: 'Маршрут не найден или не опубликован' }, { status: 404 });
    }
    // Сколько человек в группе — только для сверки мест ниже: наружу не
    // уходит, состав группы по ссылке не виден (H14).
    const { day_tour_ids: dayTourIds, people, ...plan } = read.plan;

    // Тур дня — тот, что поставил план: у черновика его назвал чат (#2225), у
    // опубликованной поездки — выбрал человек в планировщике (аудит 07.11,
    // H13). До 07.11 поездке тур подбирался заново «лучший по типу», и места
    // на дату считались для подменённого тура. Публичная страница плана
    // ведёт к брони, а не витрина цен «от-до» (разведка 08.08). Сбой подбора
    // не роняет план.
    const days = plan.days as Array<{ day?: number; activityType?: string; type?: string; coords?: [number, number] }>;
    const activityDays = days.filter((d) => d.activityType && (d.type === undefined || d.type === 'activity'));
    const isDraft = plan.source === 'draft';
    const planTours = await toursByIds(Object.values(dayTourIds ?? {}));
    const dayTours: Record<string, TopTour> = {};
    for (const [day, tourId] of Object.entries(dayTourIds ?? {})) {
      if (planTours[tourId]) dayTours[day] = planTours[tourId];
    }
    // Подбор по виду занятия (правило 1в, названо на странице) — только дням
    // поездки, где тура плана нет: поездка до 09.10 или тур снят с витрины.
    // У черновика подбора нет вовсе: он подменил бы тур, названный в чате.
    const unplanned = activityDays.filter((d) => typeof d.day !== 'number' || !dayTours[String(d.day)]);
    const topTours = isDraft || unplanned.length === 0 ? {} : await topToursByActivity(unplanned.map((d) => d.activityType as string));
    const tourFor = (d: { day?: number; activityType?: string }): TopTour | undefined =>
      (typeof d.day === 'number' ? dayTours[String(d.day)] : undefined)
      ?? (!isDraft && d.activityType ? topTours[d.activityType] : undefined);
    // Мест на дату должно хватить на всю группу; группа не записана — на одного.
    const need = typeof people === 'number' && people > 1 ? people : 1;

    // Честная доступность на дату каждого дня («Мой план 2.0», B-4):
    // «на 12.08 — 4 места» из реальной занятости (fetchAvailabilityForTour —
    // тот же расчёт, что у гейта брони). Только будущие даты.
    //
    // Пять исходов, а не «места есть» и тишина (пруф с прода 06.11: план
    // агента на 10–14.07.2027, Горелый на 11.07 без мест — ответ агенту это
    // говорил, а страница плана показывала цену и «оставить заявку» без слова):
    //  - open — на дату есть места;
    //  - none — тур ведёт расписание, на дату мест нет; next — ближайшая
    //    свободная дата в 60 сутках, если есть;
    //  - on_request — расписания в системе нет: дату подтверждает оператор
    //    по заявке, и это не «мест нет»;
    //  - unread — проверить не смогли; сбой называется, а не глушится (§4.0);
    //  - short — места есть, но меньше, чем людей в группе (H14): до 07.11
    //    одно место на двоих было «места есть». `next` — ближайшая дата,
    //    где хватит на всех.
    // Правило мест и прогноза на дату дня — lib/trips/day-fresh, одно с
    // перепроверкой поездки в личном кабинете (#3394).
    const availability: Record<string, TripDayAvailability> = {};
    const arrivalRaw = plan.arrival_date;
    const arrivalMs = arrivalRaw ? new Date(arrivalRaw).getTime() : NaN;
    if (Number.isFinite(arrivalMs)) {
      const { createPlannerCache } = await import('@/lib/planner');
      const cache = createPlannerCache();
      const today = new Date().toISOString().slice(0, 10);
      await Promise.all(activityDays.map(async (d) => {
        const tour = tourFor(d);
        if (!tour || typeof d.day !== 'number') return;
        const date = new Date(arrivalMs + (d.day - 1) * 86400000).toISOString().slice(0, 10);
        if (date < today) return;
        availability[String(d.day)] = await readDayAvailability(tour.id, date, need, cache, 'trips/share');
      }));
    }

    // Погода и «план Б» («Мой план 2.0», B-5). Прогноз Open-Meteo по
    // координатам дня — только в его горизонте (16 суток). «План Б» — не
    // сочинение модели: запасные туры заводят операторы в contingency_rules,
    // показываем их, когда тур дня погодозависим и прогноз плохой
    // (детерминированные пороги: ветер ≥ 40 км/ч или осадки ≥ 10 мм).
    // Сбой — блок не показывается, причина в логе.
    const weather: Record<string, TripDayForecast> = {};
    const planB: Record<string, Array<{ tour_id: string; slug: string | null; title: string }>> = {};
    if (Number.isFinite(arrivalMs)) {
      const today = new Date().toISOString().slice(0, 10);
      await Promise.all(activityDays.map(async (d) => {
        if (typeof d.day !== 'number' || !Array.isArray(d.coords) || d.coords.length !== 2) return;
        const date = new Date(arrivalMs + (d.day - 1) * 86400000).toISOString().slice(0, 10);
        const forecast = await readDayForecast([d.coords[0], d.coords[1]], date, today, 'trips/share');
        if (!forecast) return;
        weather[String(d.day)] = forecast;
        const tour = tourFor(d);
        if (!forecast.bad || !tour?.weather_dependent) return;
        try {
          const { createPlannerCache, fetchContingencyAlternatives } = await import('@/lib/planner');
          const alts = await fetchContingencyAlternatives(tour.id, createPlannerCache());
          if (alts.length > 0) {
            planB[String(d.day)] = alts.slice(0, 2).map((a) => ({ tour_id: a.tourId, slug: a.slug ?? null, title: a.title }));
          }
        } catch (err) {
          console.error('[trips/share] план Б на день не прочитан, SQLSTATE', (err as { code?: string } | null)?.code ?? 'нет SQLSTATE');
        }
      }));
    }

    return NextResponse.json({
      success: true,
      data: { ...plan, top_tours: topTours, day_tours: dayTours, availability, weather, plan_b: planB },
    });
  } catch (err) {
    // Отказ не глушится (§4.0): причина — в лог, без данных плана.
    const e = err as { code?: unknown; message?: unknown };
    console.error('[trips/share] план не собран:', typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
