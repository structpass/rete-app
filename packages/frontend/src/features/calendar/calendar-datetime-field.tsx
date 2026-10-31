'use client';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useOutsideClose } from '@/hooks/use-outside-close';
import { monthDays, monthLabel, monthStart, shiftMonth, todayKey } from './calendar-dates';
import './calendar-datetime-field.css';

const minutes = ['00', '15', '30', '45'];
const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
function pickerPosition(anchor: DOMRect, height: number) {
  return {
    top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - height - 8)),
    left: Math.max(8, Math.min(anchor.right - 300, window.innerWidth - 308)),
  };
}
interface Props {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}
export function CalendarDateTimeField({ label, value, disabled, onChange }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthStart(value.slice(0, 10) || todayKey()));
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const date = value.slice(0, 10) || todayKey();
  const hour = value.slice(11, 13) || '09';
  const minute = value.slice(14, 16) || '00';
  function close() {
    const returnFocus = popup.current?.contains(document.activeElement);
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }
  useOutsideClose({ active: open && !disabled, refs: [root, popup], onClose: close });
  useLayoutEffect(() => {
    if (!open || disabled || !trigger.current || !popup.current) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      setPosition(pickerPosition(anchor, popup.current!.getBoundingClientRect().height));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, month, disabled]);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const selected = popup.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    (selected ?? popup.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [open, disabled]);
  return (
    <div className="calendar-datetime-field" ref={root}>
      <label htmlFor={id}>{label}</label>
      <div className="calendar-datetime-control">
        <input
          id={id}
          className="sp-input calendar-datetime-input"
          type="datetime-local"
          required
          step={60}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          ref={trigger}
          type="button"
          aria-label={`${label}を選択`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={`${id}-picker`}
          disabled={disabled}
          onClick={() => {
            setMonth(monthStart(date));
            setOpen((old) => !old);
          }}
        >
          <CalendarDays size={18} />
        </button>
      </div>
      {open &&
        !disabled &&
        createPortal(
          <div
            id={`${id}-picker`}
            ref={popup}
            role="dialog"
            aria-label={`${label}を選択`}
            className="calendar-datetime-popup"
            style={position}
          >
            <header>
              <button
                type="button"
                aria-label={`${label}の前の月`}
                onClick={() => setMonth(shiftMonth(month, -1))}
              >
                <ChevronLeft size={16} />
              </button>
              <strong>{monthLabel(month)}</strong>
              <button
                type="button"
                aria-label={`${label}の次の月`}
                onClick={() => setMonth(shiftMonth(month, 1))}
              >
                <ChevronRight size={16} />
              </button>
            </header>
            <div className="calendar-datetime-days">
              {['日', '月', '火', '水', '木', '金', '土'].map((day) => (
                <span key={day}>{day}</span>
              ))}
              {monthDays(month).map((day) => (
                <button
                  type="button"
                  key={day}
                  className={day.slice(0, 7) === month.slice(0, 7) ? '' : 'is-outside'}
                  aria-label={day}
                  aria-pressed={day === date}
                  onClick={() => onChange(`${day}T${hour}:${minute}`)}
                >
                  {Number(day.slice(8))}
                </button>
              ))}
            </div>
            <footer>
              <select
                aria-label={`${label}の時`}
                value={hour}
                onChange={(event) => onChange(`${date}T${event.target.value}:${minute}`)}
              >
                {hours.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
              <span>:</span>
              <select
                aria-label={`${label}の分`}
                value={minute}
                onChange={(event) => onChange(`${date}T${hour}:${event.target.value}`)}
              >
                {!minutes.includes(minute) && (
                  <option disabled value={minute}>
                    {minute}（現在値）
                  </option>
                )}
                {minutes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button type="button" onClick={close}>
                完了
              </button>
            </footer>
          </div>,
          document.body,
        )}
    </div>
  );
}
