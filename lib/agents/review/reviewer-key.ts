/**
 * lib/agents/review/reviewer-key.ts — открытый ключ проверяющего ответов
 * Кузьмича (слово владельца 19.11 «у судьи баланса нет возьми на себя его
 * работу пока»).
 *
 * Выгрузка диалогов для ручной оценки (`/api/cron/kuzmich-review-batch`)
 * отдаёт тексты только шифром этим ключом. Её читает проверка прода, а лог
 * Actions у публичного репозитория открыт любому: в логе лежит шифр, открыть
 * его может только держатель закрытого ключа. Закрытый ключ в репозитории не
 * лежит и в секреты не кладётся — он у проверяющего.
 *
 * Ключ записан в коде, а не приходит параметром запроса: иначе любой, кто
 * знает пароль крон-задач, получил бы тексты своим ключом. Смена ключа — видимый
 * коммит в main. Пустая строка — выгрузка закрыта: ключа нет, тексты не отдаются.
 *
 * Отпечаток — первые 16 знаков sha256 от DER открытого ключа
 * (`openssl pkey -pubin -outform DER | sha256sum`); выгрузка печатает его рядом
 * с шифром, чтобы проверяющий видел, своим ли ключом закрыт ответ.
 *
 * Сторож: tests/unit/kuzmich-review-batch.test.ts.
 */
export const REVIEWER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAr4W3c8kI/fDG8ZO0BKWf
Yve31xESStPqCr010N9N5b13zU2hAVXmEAyLcDrXal5q6FShf2JdAt+ZWy6Mt8T4
C37mwU461vVWNdQi1cCeT6DuubYkCRsOqi8r96f+p0oTXf1WV/s2af/Ypen7B9y8
zX8WKf2LCK5pZ/yOe+Jt2wd8ev+KDvE5Vs5sIO3ruxOYFF2q0yoMi6vMrE9n/06v
OQoOMvGSEAb2XpP5iRrGfnKxOlwEV5t3a8IfO3ZoJp7gQsWgATfSyBeqTFIJlA83
DvuTgwETVGE3zGdrWsrb9f84sfVzDV3EMDP994sMxgL1nYQ6DQBXW9jSTb2yAdzC
u/NKSh+eb7Z5Ic/z4Wq5FjSALMdhIXv7YT4RED/dMzJhnppO+CCg/apuJWDo3DIm
TaOewnOQUSnVBGkaZl3XWvrLe5MPu5N1yMn+nr2LvjNIUyFEyw6mvJ3OFaSOODtG
uhmId3QvUz2UVyc48YilLKemVRAGJpBqKf6yAe9Hi631AgMBAAE=
-----END PUBLIC KEY-----
`;

/** Отпечаток ключа выше — для сверки глазами, вычисляется и в выгрузке. */
export const REVIEWER_KEY_FINGERPRINT = '4698a588d74f595d';
