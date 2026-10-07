import { useEffect, useRef, type ReactNode } from 'react';
import { safePhotoUrl } from './api';

export function Photo({
  url,
  title,
  className = '',
}: {
  url: string | null;
  title: string;
  className?: string;
}) {
  const source = safePhotoUrl(url);
  return source ? (
    <img
      className={`recipe-photo ${className}`}
      src={source}
      alt={title}
      loading="lazy"
      decoding="async"
    />
  ) : (
    <div className={`photo-empty ${className}`}>
      <ChefMark />
      <span>No recipe photo</span>
    </div>
  );
}
export function ChefMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M12 28C3 27 3 15 12 14C14 4 27 4 29 14C38 14 38 27 29 28V35H12V28Z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path d="M26 10L27 13L30 14L27 15L26 18L25 15L22 14L25 13Z" fill="currentColor" />
    </svg>
  );
}
export function Notice({
  children,
  title,
  tone = 'info',
}: {
  children: ReactNode;
  title?: string;
  tone?: 'info' | 'error' | 'success';
}) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function formatTime(value: string | null) {
  if (!value) return 'Original catalogue';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Date unavailable';
}
export function Badge({ status }: { status: 'bundled' | 'draft' | 'reviewed' }) {
  return (
    <span className={`badge ${status}`}>
      {status === 'bundled' ? 'App catalogue' : status === 'reviewed' ? 'Reviewed draft' : 'Draft'}
    </span>
  );
}
