/**
 * Ведёт ли тур расписание — ОДНО правило на все поверхности.
 *
 * Есть хоть одна будущая (по Камчатке) неотменённая дата в `tour_availability`
 * — тур ведёт календарь, и его даты считаются по местам. Нет — оператор
 * собирает группы под запрос: все даты свободны для заявки (решение владельца
 * 08.10), числа мест нет, дату и группу подтверждает он.
 *
 * Правило жило копиями: в `tourKeepsSchedule` (запрос мест), в SQL каталога
 * Кузьмича (`has_schedule`, с комментарием «то же правило») — и понадобилось
 * третьей, в планере. Три копии одного условия — три правила, как только одна
 * из них поменяется: планер сказал бы «по заявке», а проверка дат по тому же
 * туру — «расписание есть, мест нет». Сторож: tests/unit/tour-schedule-rule.test.ts.
 */

/**
 * SQL-условие «тур ведёт расписание» для тура `tourIdExpr` — колонки
 * (`ot.id`) или параметра (`$1`). Выражение пишется в коде, а не приходит
 * снаружи; всё остальное отвергается, чтобы условие нельзя было собрать из
 * строки запроса.
 */
export function keepsScheduleSql(tourIdExpr: string): string {
  if (!/^(\$\d+|[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)$/i.test(tourIdExpr)) {
    throw new Error(`keepsScheduleSql: недопустимое выражение «${tourIdExpr}»`);
  }
  return `EXISTS (
         SELECT 1 FROM tour_availability ta_sched
          WHERE ta_sched.operator_tour_id = ${tourIdExpr}
            AND ta_sched.date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date
            AND ta_sched.is_cancelled = FALSE
            AND ta_sched.deleted_at IS NULL
       )`;
}
