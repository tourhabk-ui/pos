import { NextRequest, NextResponse } from 'next/server';
import { topToursByActivity, toursByIds, type TopTour } from '@/lib/tours/top-tour-by-activity';
import { readSharedPlan } from '@/lib/trips/shared-plan';

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
    const { day_tour_ids: dayTourIds, ...plan } = read.plan;

    // Туры к дням плана: по activityType (+зона дня), тот же подбор, что у
    // /api/planner/tours-for-day. Сохранённые дни туров не несут (схема
    // сохранения режет realTour), поэтому резолвим на чтении — публичная
    // страница плана должна вести к брони, а не быть витриной цен «от-до»:
    // «план, который бронирует» — наше отличие от планировщиков TAAFT
    // (разведка 08.08, карт-бланш владельца). Сбой подбора не роняет план.
    const days = plan.days as Array<{ day?: number; activityType?: string; type?: string; coords?: [number, number] }>;
    const activityDays = days.filter((d) => d.activityType && (d.type === undefined || d.type === 'activity'));
    // У черновика тур дня уже выбран планом — показываем его; подбор «лучшего
    // по типу» там подменил бы тур, названный в чате, другим (#2225).
    const isDraft = plan.source === 'draft';
    const topTours = isDraft ? {} : await topToursByActivity(activityDays.map((d) => d.activityType as string));
    const planTours = isDraft ? await toursByIds(Object.values(dayTourIds ?? {})) : {};
    const dayTours: Record<string, TopTour> = {};
    for (const [day, tourId] of Object.entries(dayTourIds ?? {})) {
      if (planTours[tourId]) dayTours[day] = planTours[tourId];
    }
    const tourFor = (d: { day?: number; activityType?: string }): TopTour | undefined => (isDraft
      ? (typeof d.day === 'number' ? dayTours[String(d.day)] : undefined)
      : (d.activityType ? topTours[d.activityType] : undefined));

    // Честная доступность на дату каждого дня («Мой план 2.0», B-4):
    // «на 12.08 — 4 места» из реальной занятости (fetchAvailabilityForTour —
    // тот же расчёт, что у гейта брони). Только будущие даты; сбой подбора
    // не роняет план — строка доступности просто не показывается.
    const availability: Record<string, { date: string; remaining: number }> = {};
    const arrivalRaw = plan.arrival_date;
    const arrivalMs = arrivalRaw ? new Date(arrivalRaw).getTime() : NaN;
    if (Number.isFinite(arrivalMs)) {
      const { createPlannerCache, fetchAvailabilityForTour } = await import('@/lib/planner');
      const cache = createPlannerCache();
      const today = new Date().toISOString().slice(0, 10);
      await Promise.all(activityDays.map(async (d) => {
        const tour = tourFor(d);
        if (!tour || typeof d.day !== 'number') return;
        const date = new Date(arrivalMs + (d.day - 1) * 86400000).toISOString().slice(0, 10);
        if (date < today) return;
        try {
          const slots = await fetchAvailabilityForTour(tour.id, date, date, cache);
          const remaining = slots[0]?.remaining ?? 0;
          if (remaining > 0) availability[String(d.day)] = { date, remaining };
        } catch { /* строка доступности необязательна */ }
      }));
    }

    // Погода и «план Б» («Мой план 2.0», B-5). Прогноз Open-Meteo по
    // координатам дня — только в его горизонте (16 суток). «План Б» — не
    // сочинение модели: запасные туры заводят операторы в contingency_rules,
    // показываем их, когда тур дня погодозависим и прогноз плохой
    // (детерминированные пороги: ветер ≥ 40 км/ч или осадки ≥ 10 мм).
    // Любой сбой — блок просто не показывается.
    const weather: Record<string, { date: string; tempMin: number; tempMax: number; windKmh: number; precipMm: number; description: string; bad: boolean }> = {};
    const planB: Record<string, Array<{ tour_id: string; slug: string | null; title: string }>> = {};
    if (Number.isFinite(arrivalMs)) {
      try {
        const { createPlannerCache, fetchForecastDays, fetchContingencyAlternatives } = await import('@/lib/planner');
        const cache = createPlannerCache();
        const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
        const horizonMs = todayMs + 16 * 86400000;
        await Promise.all(activityDays.map(async (d) => {
          if (typeof d.day !== 'number' || !Array.isArray(d.coords) || d.coords.length !== 2) return;
          const dateMs = arrivalMs + (d.day - 1) * 86400000;
          if (dateMs < todayMs || dateMs >= horizonMs) return;
          const date = new Date(dateMs).toISOString().slice(0, 10);
          try {
            const daysAhead = Math.ceil((dateMs - todayMs) / 86400000) + 1;
            const forecast = await fetchForecastDays(d.coords[0], d.coords[1], Math.min(16, daysAhead));
            if (!forecast.ok) return;
            const f = forecast.days.find((x) => x.date === date);
            // Неполный день не показывается: ноль вместо пропуска рисовал
            // туристу штиль и «0 °C» там, где данных не было (§4.0).
            if (!f || f.tempMin === null || f.tempMax === null || f.windKmh === null
              || f.precipMm === null || f.description === null) return;
            const bad = f.windKmh >= 40 || f.precipMm >= 10;
            weather[String(d.day)] = {
              date, tempMin: Math.round(f.tempMin), tempMax: Math.round(f.tempMax),
              windKmh: Math.round(f.windKmh), precipMm: Math.round(f.precipMm),
              description: f.description, bad,
            };
            const tour = tourFor(d);
            if (bad && tour?.weather_dependent) {
              const alts = await fetchContingencyAlternatives(tour.id, cache);
              if (alts.length > 0) {
                planB[String(d.day)] = alts.slice(0, 2).map((a) => ({ tour_id: a.tourId, slug: a.slug ?? null, title: a.title }));
              }
            }
          } catch { /* погода и план Б необязательны */ }
        }));
      } catch { /* движок недоступен — план живёт без погоды */ }
    }

    return NextResponse.json({
      success: true,
      data: { ...plan, top_tours: topTours, ...(isDraft ? { day_tours: dayTours } : {}), availability, weather, plan_b: planB },
    });
  } catch (err) {
    // Отказ не глушится (§4.0): причина — в лог, без данных плана.
    const e = err as { code?: unknown; message?: unknown };
    console.error('[trips/share] план не собран:', typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
