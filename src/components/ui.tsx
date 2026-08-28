import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-amber-400 text-stone-950 hover:bg-amber-300 active:bg-amber-500',
  ghost: 'bg-white/10 text-stone-100 hover:bg-white/20 active:bg-white/25',
  danger: 'bg-red-500/15 text-red-300 hover:bg-red-500/25 active:bg-red-500/30',
};

export function Button({
  variant = 'ghost',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function IconButton({
  label,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={`inline-flex size-11 items-center justify-center rounded-full bg-black/50 text-stone-100 backdrop-blur transition hover:bg-black/70 disabled:opacity-40 ${className}`}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-stone-100">{label}</span>
        {hint && <span className="block text-xs text-stone-400">{hint}</span>}
      </span>
      <span className="relative shrink-0">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="block h-6 w-11 rounded-full bg-white/15 transition peer-checked:bg-amber-400" />
        <span className="pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full bg-white transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

export function Screen({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex min-h-dvh flex-col bg-stone-950 text-stone-100 ${className}`}>{children}</div>;
}

export function TopBar({ title, left, right }: { title: string; left?: ReactNode; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-white/10 bg-stone-950/90 px-3 py-3 backdrop-blur">
      <div className="flex min-w-11 justify-start">{left}</div>
      <h1 className="flex-1 truncate text-center text-base font-semibold">{title}</h1>
      <div className="flex min-w-11 justify-end">{right}</div>
    </header>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-sm text-stone-300" role="status">
      <span className="size-8 animate-spin rounded-full border-2 border-white/20 border-t-amber-400" />
      {label}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="text-lg font-medium text-stone-200">{title}</p>
      <p className="max-w-sm text-sm text-stone-400">{hint}</p>
      {action}
    </div>
  );
}
