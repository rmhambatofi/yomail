import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import {
  AuthCard,
  Field,
  FormError,
  FormNotice,
  SubmitButton,
  describeAuthError,
} from '../components/AuthForm';
import { safeNext, useAuth } from '../lib/auth';

export function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    document.title = 'Sign in — yomail';
  }, []);

  if (user) return <Navigate to={next} replace />;

  const disabled = error instanceof ApiError && error.code === 'ACCOUNT_DISABLED';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResent(false);
    try {
      const profile = await api.login({ identifier, password });
      setUser(profile);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    try {
      // The API needs the email; the identifier may be a username, so ask for the email then.
      const email = identifier.includes('@') ? identifier : window.prompt('Your email address');
      if (!email) return;
      await api.resendConfirmation(email);
      setResent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          id="identifier"
          label="Email or username"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          required
          spellCheck={false}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error != null && <FormError>{describeAuthError(error)}</FormError>}
        {disabled && !resent && (
          <button
            type="button"
            onClick={resend}
            disabled={busy}
            className="text-sm font-medium text-sky-700 hover:underline disabled:opacity-50"
          >
            Resend the confirmation email
          </button>
        )}
        {resent && <FormNotice>Confirmation email sent. Check your inbox.</FormNotice>}
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm text-slate-600">
        <Link to="/forgot-password" className="font-medium text-sky-700 hover:underline">
          Forgot password?
        </Link>
        <Link to="/signup" className="font-medium text-sky-700 hover:underline">
          Create an account
        </Link>
      </div>
    </AuthCard>
  );
}
