import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { btnSecondary } from './Feedback';

export function Layout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? 'max-w-7xl' : 'max-w-4xl';
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className={`mx-auto flex ${width} items-center justify-between gap-3 px-4 py-3`}>
          <div className="flex items-baseline gap-2">
            <Link to="/" className="text-lg font-bold tracking-tight text-slate-900">
              yomail
            </Link>
            <span className="hidden text-xs text-slate-500 sm:inline">webhook catcher</span>
          </div>
          <AuthMenu />
        </div>
      </header>
      <main className={`mx-auto w-full ${width} flex-1 px-4 py-6`}>{children}</main>
      <footer className="px-4 py-4 text-center text-xs text-slate-400">
        Anyone who knows the id of an anonymous endpoint can read its requests; endpoints owned by a
        member are private to them. Do not send anything sensitive.
      </footer>
    </div>
  );
}

/** Right side of the header: "Sign in / Sign up" when anonymous, username + "Sign out" otherwise. */
function AuthMenu() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  if (loading) return <span className="h-8 w-24" aria-hidden="true" />;
  if (!user) {
    return (
      <Link to="/login" className={btnSecondary} data-testid="auth-signin">
        Sign in / Sign up
      </Link>
    );
  }
  const signOut = async () => {
    await logout();
    navigate('/');
  };
  return (
    <div className="flex items-center gap-3 text-sm">
      <Link
        to="/account"
        className="max-w-[10rem] truncate font-medium text-slate-800 hover:underline"
        title="Your account"
        data-testid="auth-user"
      >
        {user.username}
      </Link>
      <button type="button" onClick={signOut} className={btnSecondary} data-testid="auth-signout">
        Sign out
      </button>
    </div>
  );
}
