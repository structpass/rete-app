'use client';
import { useRef, useState } from 'react';
import type { CalendarEventDetail, CalendarEventSummary } from '@rete/shared';
import { useDiscardConfirm } from '@/hooks/use-discard-confirm';
import { useEscapeConsume } from '@/hooks/use-escape-consume';
import { useHomePermissions } from '@/features/dashboard/hooks/home-permissions-context';
import { useCalendarNavigation } from './use-calendar-navigation';
import { createEditorActions } from './calendar-editor-actions';
export type CalendarFormValues = {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  memo: string;
  tagIds: string[];
};
export type CalendarPanel = 'list' | 'view' | 'create' | 'edit';
export interface CalendarEditorOptions {
  active: string;
  selectDate: (key: string) => void;
  listFrom: string;
  listTo: string;
  refresh: () => Promise<CalendarEventSummary[] | false | null>;
}
function useEditorState() {
  const [panel, setPanel] = useState<CalendarPanel>('list');
  const [focusTitle, setFocusTitle] = useState(true);
  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [form, setForm] = useState<CalendarFormValues>({
    title: '',
    allDay: false,
    start: '',
    end: '',
    memo: '',
    tagIds: [],
  });
  const [initial, setInitial] = useState<CalendarFormValues>(form);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false),
    [picker, setPicker] = useState(false);
  const selection = useRef(0),
    saved = useRef<string | null>(null);
  return {
    panel,
    setPanel,
    focusTitle,
    setFocusTitle,
    detail,
    setDetail,
    form,
    setForm,
    initial,
    setInitial,
    busy,
    setBusy,
    error,
    setError,
    deleteOpen,
    setDeleteOpen,
    picker,
    setPicker,
    selection,
    saved,
  };
}
export type CalendarEditorState = ReturnType<typeof useEditorState>;
export function useCalendarEditor(options: CalendarEditorOptions) {
  const state = useEditorState(),
    permissions = useHomePermissions(),
    discard = useDiscardConfirm();
  const editing = state.panel === 'create' || state.panel === 'edit';
  const dirty = editing && JSON.stringify(state.form) !== JSON.stringify(state.initial);
  useCalendarNavigation(dirty, state.busy, discard.request);
  function leave(action: () => void) {
    if (!state.busy) discard.request(dirty, action);
  }
  function returnToList(after?: () => void) {
    leave(() => {
      state.selection.current++;
      state.setPanel('list');
      state.setError('');
      after?.();
    });
  }
  function back() {
    returnToList();
  }
  useEscapeConsume(back, { enabled: state.panel !== 'list' && !state.picker && !state.deleteOpen });
  const actions = createEditorActions(state, options, permissions, leave);
  return { ...state, ...actions, discard, editing, leave, back, returnToList };
}
export type CalendarEditor = ReturnType<typeof useCalendarEditor>;
