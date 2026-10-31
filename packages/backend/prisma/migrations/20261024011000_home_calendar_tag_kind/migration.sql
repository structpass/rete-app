ALTER TABLE "announcement_tags" DROP CONSTRAINT "announcement_tags_kind_check";
ALTER TABLE "announcement_tags" ADD CONSTRAINT "announcement_tags_kind_check" CHECK ("kind" IN ('board', 'calendar', 'faq'));
