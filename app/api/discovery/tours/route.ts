// POST отсюда снят вместе с POST /api/tours (аудит 15.10, P2-02): реэкспорт
// вёл в тот же INSERT INTO tours, который не выполнялся ни разу. Тур заводит
// кабинет оператора — POST /api/hub/operator/tours.
export { dynamic, GET } from "@/app/api/tours/route";
