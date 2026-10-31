'use client';
import { Tags } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TagIcon } from '@/components/tags/tag-icon';
import type { TagLike } from '@/hooks/use-tag-master';
export function CalendarTagChips({ tags }: { tags: TagLike[] }) {
  return (
    <div className="calendar-tag-chips">
      {tags.map((tag) => (
        <Badge key={tag.id} variant="outline">
          <TagIcon name={tag.icon} size={12} color={tag.color} />
          <span>{tag.name}</span>
        </Badge>
      ))}
    </div>
  );
}
export function CalendarTagField({
  tags,
  disabled,
  onEdit,
}: {
  tags: TagLike[];
  disabled: boolean;
  onEdit: () => void;
}) {
  return (
    <section className="calendar-tag-field" aria-label="予定のタグ">
      <div className="calendar-tag-heading">
        <span>タグ</span>
        <Button
          type="button"
          variant="ghost"
          className="h-5 px-1 py-0 text-xs"
          aria-label="タグを編集"
          disabled={disabled}
          onClick={onEdit}
        >
          <Tags size={14} aria-hidden="true" />
          編集
        </Button>
      </div>
      <CalendarTagChips tags={tags} />
    </section>
  );
}
