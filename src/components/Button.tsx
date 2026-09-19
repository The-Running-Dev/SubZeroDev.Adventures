import type { ButtonHTMLAttributes } from "react";
export function Button({
  className = "",
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`app-button app-button--${variant} ${className}`}
    />
  );
}
