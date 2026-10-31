import type { TagLike } from '@/hooks/use-tag-master';

export function calendarPickerTags(master: TagLike[], saved: TagLike[], selected: string[]) {
  const choices = new Map(master.filter((tag) => !tag.archived).map((tag) => [tag.id, tag]));
  // Selected tags can be removed from the master while the form is open.
  // Keep them visible so the user can remove the stale assignment and save.
  for (const id of selected) {
    if (choices.has(id)) continue;
    const tag = master.find((tag) => tag.id === id) ?? saved.find((tag) => tag.id === id);
    choices.set(
      id,
      tag ?? { id, name: '削除されたタグ', icon: 'Tag', color: 'gray', archived: true },
    );
  }
  return [...choices.values()];
}
