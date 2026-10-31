-- A calendar event can have zero or one tag (d882).
--
-- 以前の版は重複の掃除無しに CREATE UNIQUE INDEX を打っていた。この移行より前の版
-- （ホームカレンダーの初期版）は 1 つの予定に複数のタグを付けて保存できたため、索引を
-- 足した瞬間に移行が落ち、同じ配布単位の祝日・終日の移行ごと止まるおそれがあった。
-- 決定的に片付けてから索引を足す。
--
-- 残すのは 1 件だけ。残す 1 件はタグ名の昇順（同順の時は tag_id の昇順）で 1 件目にし、
-- 判定は照合順序（ロケール）に依存させない（移行中に一度だけ作る列挙を使う）。
-- 表を作った移行（20261024010000）に CHECK 制約は無く、削除の前にこの列挙が表へ何も
-- 足さない（列・索引・制約を増やさない）ため、後始末は DROP TYPE だけで足りる。
CREATE TYPE "calendar_event_tag_assignments_dup_rank" AS ENUM ('keep', 'drop');

ALTER TABLE "calendar_event_tag_assignments"
  ADD COLUMN "_dup_rank" "calendar_event_tag_assignments_dup_rank";

UPDATE "calendar_event_tag_assignments" AS a
SET "_dup_rank" = CASE
  WHEN ranked.rn = 1 THEN 'keep'::"calendar_event_tag_assignments_dup_rank"
  ELSE 'drop'::"calendar_event_tag_assignments_dup_rank"
END
FROM (
  SELECT
    a2."event_id",
    a2."tag_id",
    ROW_NUMBER() OVER (
      PARTITION BY a2."event_id"
      ORDER BY t."name" ASC, a2."tag_id" ASC
    ) AS rn
  FROM "calendar_event_tag_assignments" AS a2
  JOIN "announcement_tags" AS t ON t."id" = a2."tag_id"
) AS ranked
WHERE a."event_id" = ranked."event_id" AND a."tag_id" = ranked."tag_id";

DELETE FROM "calendar_event_tag_assignments"
WHERE "_dup_rank" = 'drop'::"calendar_event_tag_assignments_dup_rank";

-- 列を消すと列の上の既定値も一緒に消える（ここで消さないと型が消せない）。
ALTER TABLE "calendar_event_tag_assignments" DROP COLUMN "_dup_rank";

DROP TYPE "calendar_event_tag_assignments_dup_rank";

-- A calendar event can have zero or one tag. The surviving assignments are preserved.
CREATE UNIQUE INDEX "calendar_event_tag_assignments_event_id_key" ON "calendar_event_tag_assignments"("event_id");
