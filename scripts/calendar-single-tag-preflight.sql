-- 本番移行前の重複計測（読み取りのみ・d923）
--
-- 用途: 20261025030000_calendar_single_tag を本番へ当てる前に、複数タグを持つ予定が何件あるかを測る。
--   移行は重複をタグ名の昇順（同名は tag_id の昇順）で 1 件だけ残して片付けてから一意索引を足すため、落ちはしないが、
--   「何件の割当が黙って消えるか」を先に知っておかないと、消えた後に気づけない。
-- 実行: docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
--         sh -ec 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--         < scripts/calendar-single-tag-preflight.sql
--   ユーザー名と DB 名はコンテナが持つ値を使う（手元の .env.production に直書きしない）。
--
-- 返す列:
--   events_with_tags       … タグが 1 件以上付いた予定の総数
--   events_with_duplicates … 複数タグを持つ予定の数（重複が生じている予定の件数）
--   assignments_total      … 割当の総数
--   assignments_dropped    … 移行で消える割当の見込み数
--   widest_event           … 1 つの予定に付いているタグの最大数
SELECT
  (SELECT count(DISTINCT event_id) FROM "calendar_event_tag_assignments") AS events_with_tags,
  (
    SELECT count(*) FROM (
      SELECT event_id
      FROM "calendar_event_tag_assignments"
      GROUP BY event_id
      HAVING count(*) > 1
    ) AS dup
  ) AS events_with_duplicates,
  (SELECT count(*) FROM "calendar_event_tag_assignments") AS assignments_total,
  (SELECT count(*) FROM "calendar_event_tag_assignments") - (SELECT count(DISTINCT event_id) FROM "calendar_event_tag_assignments") AS assignments_dropped,
  coalesce(
    (SELECT max(n) FROM (SELECT count(*) AS n FROM "calendar_event_tag_assignments" GROUP BY event_id) AS w),
    0
  ) AS widest_event;
