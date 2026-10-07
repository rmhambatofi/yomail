import type { InputHTMLAttributes, ReactNode } from 'react';
import { Layout } from './Layout';
import { btnPrimary } from './Feedback';
import { ApiError } from '../api/client';

/** Narrow centered card used by every account page. */
export function AuthCard({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Layout>
      <section className="mx-auto max-w-md py-8">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {intro && <p className="mt-2 text-sm text-slate-600">{intro}</p>}
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {children}
        </div>
      </section>
    </Layout>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  hint?: string;
  /** Server-side problem for this field (400 VALIDATION). */
  error?: string;
}

export function Field({ id, label, hint, error, className, ...input }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        name={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus:outline-none ${
          error ? 'border-red-400 focus:border-red-500' : 'border-slate-300 focus:border-sky-500'
        } ${className ?? ''}`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy} className={`${btnPrimary} w-full py-2`}>
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
      role="alert"
    >
      {children}
    </p>
  );
}

export function FormNotice({ children }: { children: ReactNode }) {
  return (
    <p
      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      role="status"
    >
      {children}
    </p>
  );
}

/** Human message for an auth error; keyed on the API code, never on its message. */
export function describeAuthError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'INVALID_CREDENTIALS':
        return 'Wrong email/username or password.';
      case 'ACCOUNT_DISABLED':
        return 'Your email address is not confirmed yet. Check your inbox or resend the email.';
      case 'EMAIL_TAKEN':
        return 'This email is already registered.';
      case 'USERNAME_TAKEN':
        return 'This username is already taken.';
      case 'TOKEN_INVALID':
        return 'This link is invalid or has expired.';
      case 'WRONG_PASSWORD':
        return 'The current password is wrong.';
      case 'UNAUTHENTICATED':
        return 'Please sign in first.';
      case 'VALIDATION':
        return 'Some fields are invalid.';
      case 'NOT_OWNER':
        return 'Only the owner of this endpoint can do that.';
      case 'REPLAY_FAILED':
        return `The target could not be reached (${err.message}).`;
      default:
        break;
    }
    if (err.status === 429) return 'Too many attempts. Please try again in a few minutes.';
    return `Something went wrong (${err.message}).`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Field problems of a 400 VALIDATION error, or an empty object. */
export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError && err.fields ? err.fields : {};
}
