export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="gs-field">
      <span className="gs-field-label">{label}</span>
      {children}
      {hint && <span className="gs-dim gs-field-hint">{hint}</span>}
    </label>
  );
}
