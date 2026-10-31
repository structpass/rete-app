-- 期間で絞る一覧（d883）が、端の片側だけでなく両端とも索引で読めるようにする。
-- 期間の中で始まる予定は start_at の範囲で、期間より前から続く予定は end_at の範囲で引く。
-- end_at の索引は id を添えて 1 本に束ねる（単独の索引はこの複合索引の先頭列で置き換わる）。
DROP INDEX "calendar_events_end_at_idx";
CREATE INDEX "calendar_events_end_at_id_idx" ON "calendar_events"("end_at", "id");
