import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import {
  AuthCard,
  Field,
  FormError,
  FormNotice,
  SubmitButton,
  describeAuthError,
} from '../components/AuthForm';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    document.title = 'Forgot password — yomail';
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Forgot your password?"
      intro="Enter your email address and we will send you a link to choose a new one."
    >
      {sent ? (
        <FormNotice>
          If an account exists for <strong>{email}</strong>, a reset link is on its way. It is valid
          for a short time.
        </FormNotice>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          {error != null && <FormError>{describeAuthError(error)}</FormError>}
          <SubmitButton busy={busy}>Send the reset link</SubmitButton>
        </form>
      )}
      <p className="mt-4 text-center text-sm text-slate-600">
        <Link to="/login" className="font-medium text-sky-700 hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
