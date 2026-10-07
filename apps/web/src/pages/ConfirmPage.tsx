import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  AuthCard,
  Field,
  FormError,
  FormNotice,
  SubmitButton,
  describeAuthError,
} from '../components/AuthForm';
import { Spinner, btnPrimary } from '../components/Feedback';
import { useAuth } from '../lib/auth';

/**
 * Landing page of the confirmation email. The token is consumed with a POST from here
 * (never by the GET of the link itself) so link prefetchers cannot burn it.
 */
export function ConfirmPage() {
  const { token = '' } = useParams();
  const { setUser } = useAuth();
  const [state, setState] = useState<'pending' | 'done' | 'failed'>('pending');
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    document.title = 'Confirm your account — yomail';
  }, []);

  useEffect(() => {
    // StrictMode mounts twice in dev; the token is single-use, so guard the call.
    if (started.current) return;
    started.current = true;
    api
      .confirm(token)
      .then((profile) => {
        setUser(profile);
        setState('done');
      })
      .catch((err: unknown) => {
        setError(err);
        setState('failed');
      });
  }, [token, setUser]);

  const resend = async (e: FormEvent) => {
    e.preventDefault();
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

  if (state === 'pending') {
    return (
      <AuthCard title="Confirming your account…">
        <Spinner label="Activating your account…" />
      </AuthCard>
    );
  }

  if (state === 'done') {
    return (
      <AuthCard title="Your account is active">
        <FormNotice>Thanks for confirming your email. You are now signed in.</FormNotice>
        <Link to="/" className={`${btnPrimary} mt-4 w-full py-2`}>
          Go to home
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="This link does not work"
      intro="It may have expired, been used already, or your account may already be active."
    >
      <FormError>{describeAuthError(error)}</FormError>
      <p className="mt-4 text-sm text-slate-600">
        Already confirmed?{' '}
        <Link to="/login" className="font-medium text-sky-700 hover:underline">
          Sign in
        </Link>
        . Otherwise, get a fresh link:
      </p>
      {resent ? (
        <div className="mt-3">
          <FormNotice>
            If an unconfirmed account exists for that address, a new email is on its way.
          </FormNotice>
        </div>
      ) : (
        <form onSubmit={resend} className="mt-3 space-y-3">
          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <SubmitButton busy={busy}>Resend the confirmation email</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
