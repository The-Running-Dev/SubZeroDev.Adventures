import { useTranslation } from "react-i18next";
import { findingMessage, type useDraftValidation } from "../draft-validation";

export function ValidationConsole({
  validation,
}: {
  readonly validation: ReturnType<typeof useDraftValidation>;
}) {
  const { t } = useTranslation("creator");
  const { ok, errors, warnings, fatal } = validation;
  return (
    <section className="gs-console" aria-label={t("validation")}>
      <p className="gs-eyebrow gs-amber">
        {t("validationTitle", {
          result: ok
            ? t("passes")
            : t("toFix", { count: errors.length + (fatal ? 1 : 0) }),
        })}
      </p>
      <ul className="gs-checks">
        {fatal && (
          <li className="gs-check gs-check-todo">
            <span aria-hidden="true">[ ]</span> {t("fatal")}
            <details>
              <summary>{t("diagnostics")}</summary>
              <pre>{fatal}</pre>
            </details>
          </li>
        )}
        {errors.map((error, index) => (
          <li key={`e${index}`} className="gs-check gs-check-todo">
            <span aria-hidden="true">[ ]</span>{" "}
            {t(
              `validation:${findingMessage(error).key}`,
              findingMessage(error).values,
            )}
          </li>
        ))}
        {warnings.map((warning, index) => (
          <li key={`w${index}`} className="gs-check gs-check-locked">
            <span aria-hidden="true">[–]</span>{" "}
            {t(
              `validation:${findingMessage(warning).key}`,
              findingMessage(warning).values,
            )}
          </li>
        ))}
        {ok && warnings.length === 0 && (
          <li className="gs-check gs-check-done">
            <span aria-hidden="true">[×]</span>
            {t("noFindings")}
          </li>
        )}
      </ul>
      {warnings.length > 0 && <p className="gs-dim">{t("warnings")}</p>}
    </section>
  );
}
