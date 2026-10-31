-- AlterTable
ALTER TABLE "user_groups" ADD COLUMN     "can_edit_home_board" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "can_edit_home_calendar" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "can_edit_home_faq" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "can_manage_home_tags" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "memo" VARCHAR(20000) NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_tag_assignments" (
    "event_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,

    CONSTRAINT "calendar_event_tag_assignments_pkey" PRIMARY KEY ("event_id","tag_id")
);

-- CreateIndex
CREATE INDEX "calendar_events_start_at_id_idx" ON "calendar_events"("start_at", "id");

-- CreateIndex
CREATE INDEX "calendar_events_end_at_idx" ON "calendar_events"("end_at");

-- CreateIndex
CREATE INDEX "calendar_events_created_by_id_idx" ON "calendar_events"("created_by_id");

-- CreateIndex
CREATE INDEX "calendar_events_updated_by_id_idx" ON "calendar_events"("updated_by_id");

-- CreateIndex
CREATE INDEX "calendar_event_tag_assignments_tag_id_idx" ON "calendar_event_tag_assignments"("tag_id");

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_tag_assignments" ADD CONSTRAINT "calendar_event_tag_assignments_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_tag_assignments" ADD CONSTRAINT "calendar_event_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "announcement_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_period_check" CHECK ("end_at" > "start_at"), ADD CONSTRAINT "calendar_events_revision_check" CHECK ("revision" > 0);
