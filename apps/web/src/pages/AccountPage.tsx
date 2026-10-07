import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@yomail/shared';
import { api } from '../api/client';
import {
  AuthCard,
  Field,
  FormError,
  FormNotice,
  SubmitButton,
  describeAuthError,
  fieldErrors,
} from '../components/AuthForm';
import { btnDanger, btnSecondary } from '../components/Feedback';
import { useAuth } from '../lib/auth';
import { fullDate } from '../lib/format';

/** Rendered inside RequireAuth, so `user` is always present here. */
export function AccountPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<unknown>(null);
  const [pwDone, setPwDone] = useState(false);
  const [delPassword, setDelPassword] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Your account — yomail';
  }, []);

  if (!user) return null;

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwBusy(true);
    setPwError(null);
    setPwDone(false);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setPwDone(true);
    } catch (err) {
      setPwError(err);
    } finally {
      setPwBusy(false);
    }
  };

  const deleteAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm('Delete your account? This cannot be undone.')) return;
    setDelBusy(true);
    setDelError(null);
    try {
      await api.deleteAccount(delPassword);
      setUser(null);
      navigate('/', { replace: true });
    } catch (err) {
      setDelError(err);
      setDelBusy(false);
    }
  };

  const pwFields = fieldErrors(pwError);
  return (
    <AuthCard title="Your account">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Username</dt>
        <dd className="font-medium text-slate-900">{user.username}</dd>
        <dt className="text-slate-500">Email</dt>
        <dd className="text-slate-900">{user.email}</dd>
        <dt className="text-slate-500">Role</dt>
        <dd>
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
              user.role === 'ADMIN' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {user.role}
          </span>
        </dd>
        <dt className="text-slate-500">Member since</dt>
        <dd className="text-slate-900">{fullDate(user.created_at)}</dd>
      </dl>

      {user.role === 'ADMIN' && (
        <section className="mt-8" data-testid="admin-section">
          <h2 className="text-base font-semibold text-slate-900">Administration</h2>
          <p className="mt-1 text-sm text-slate-600">
            The dev mail catcher keeps the emails that other applications under development post to
            it (and, outside production, the emails this app would send). Only admins can read them.
          </p>
          <a
            href="/devmailcatcher"
            target="_blank"
            rel="noopener"
            className={`${btnSecondary} mt-3 inline-block`}
            data-testid="open-mail-catcher"
          >
            Open the dev mail catcher
          </a>
        </section>
      )}

      <h2 className="mt-8 text-base font-semibold text-slate-900">Change password</h2>
      <form onSubmit={changePassword} className="mt-3 space-y-4" noValidate>
        <Field
          id="current_password"
          label="Current password"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
        <Field
          id="new_password"
          label="New password"
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Other devices will be signed out.`}
          error={pwFields.new_password}
        />
        {pwError != null && Object.keys(pwFields).length === 0 && (
          <FormError>{describeAuthError(pwError)}</FormError>
        )}
        {pwDone && <FormNotice>Password changed.</FormNotice>}
        <SubmitButton busy={pwBusy}>Change password</SubmitButton>
      </form>

      <h2 className="mt-8 text-base font-semibold text-red-800">Delete account</h2>
      <p className="mt-1 text-sm text-slate-600">
        Your endpoints lose their owner: they become readable again by anyone who knows their id.
        Your username and email become available again.
      </p>
      <form onSubmit={deleteAccount} className="mt-3 space-y-3" noValidate>
        <Field
          id="delete_password"
          label="Your password"
          type="password"
          value={delPassword}
          onChange={(e) => setDelPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {delError != null && <FormError>{describeAuthError(delError)}</FormError>}
        <button type="submit" disabled={delBusy} className={`${btnDanger} w-full py-2`}>
          {delBusy ? 'Deleting…' : 'Delete my account'}
        </button>
      </form>
    </AuthCard>
  );
}
