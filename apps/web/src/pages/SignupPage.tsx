import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@yomail/shared';
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
import { useAuth } from '../lib/auth';

export function SignupPage() {
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    document.title = 'Sign up — yomail';
  }, []);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signup({ username, email, password });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    try {
      await api.resendConfirmation(email);
      setResent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title="Check your inbox">
        <FormNotice>
          We sent a confirmation email to <strong>{email}</strong>. Click the button in it to
          activate your account.
        </FormNotice>
        <p className="mt-4 text-sm text-slate-600">
          Nothing after a few minutes? Check your spam folder, or{' '}
          <button
            type="button"
            onClick={resend}
            disabled={busy || resent}
            className="font-medium text-sky-700 hover:underline disabled:opacity-50"
          >
            {resent ? 'email sent again' : 'send it again'}
          </button>
          .
        </p>
        {error != null && (
          <div className="mt-3">
            <FormError>{describeAuthError(error)}</FormError>
          </div>
        )}
      </AuthCard>
    );
  }

  const fields = fieldErrors(error);
  return (
    <AuthCard
      title="Create an account"
      intro="Free. Accounts unlock features reserved to members; anonymous endpoints keep working without one."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          id="username"
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          minLength={USERNAME_MIN_LENGTH}
          maxLength={USERNAME_MAX_LENGTH}
          pattern="[A-Za-z0-9_]+"
          hint={`${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} letters, digits or underscores.`}
          error={fields.username}
          spellCheck={false}
        />
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          hint="We only use it to confirm your account and reset your password."
          error={fields.email}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={fields.password}
        />
        {error != null && Object.keys(fields).length === 0 && (
          <FormError>{describeAuthError(error)}</FormError>
        )}
        <SubmitButton busy={busy}>Sign up</SubmitButton>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-sky-700 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
