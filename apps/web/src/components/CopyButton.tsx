import { useEffect, useState } from 'react';
import { btnSecondary } from './Feedback';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      window.prompt('Copy this value', value);
    }
  };

  return (
    <button type="button" onClick={copy} className={btnSecondary} aria-live="polite">
      {copied ? 'Copied!' : label}
    </button>
  );
}
