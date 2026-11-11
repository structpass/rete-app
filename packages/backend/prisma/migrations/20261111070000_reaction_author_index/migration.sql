-- 投稿者 Account の削除時（onDelete: Restrict）に reactions を全件走査しないための index（§13.4・d1262）。
CREATE INDEX "reactions_author_id_idx" ON "reactions"("author_id");
