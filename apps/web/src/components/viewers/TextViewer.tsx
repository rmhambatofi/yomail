export function TextViewer({ text }: { text: string }) {
  return (
    <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-900 p-4 font-mono text-xs leading-5 text-slate-100">
      {text}
    </pre>
  );
}
