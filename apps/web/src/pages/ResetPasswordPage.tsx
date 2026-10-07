import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
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
import { btnPrimary } from '../components/Feedback';

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = 'Choose a new password — yomail';
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title="Password updated">
        <FormNotice>Your password has been changed and every session was signed out.</FormNotice>
        <Link to="/login" className={`${btnPrimary} mt-4 w-full py-2`}>
          Sign in
        </Link>
      </AuthCard>
    );
  }

  const fields = fieldErrors(error);
  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          id="password"
          label="New password"
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
        <Field
          id="confirm"
          label="Repeat the new password"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          error={mismatch ? 'The two passwords differ.' : undefined}
        />
        {error != null && Object.keys(fields).length === 0 && (
          <FormError>
            {describeAuthError(error)}{' '}
            <Link to="/forgot-password" className="font-medium underline">
              Request a new link
            </Link>
          </FormError>
        )}
        <SubmitButton busy={busy}>Save the new password</SubmitButton>
      </form>
    </AuthCard>
  );
}
