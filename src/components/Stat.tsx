import { useLocale } from "../app/locale/useLocale";
export function Stat({ label, value }: { label: string; value: number }) {
  const { number } = useLocale();
  return (
    <div className="app-stat">
      <dt>{label}</dt>
      <dd>{Number.isFinite(value) ? number(value) : "—"}</dd>
    </div>
  );
}
