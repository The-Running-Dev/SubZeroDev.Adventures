import { useEffect, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { createLocaleInstance } from "../locale/locale";

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [instance] = useState(createLocaleInstance);
  useEffect(() => {
    const apply = () => {
      document.documentElement.lang = instance.resolvedLanguage ?? "en";
    };
    apply();
    instance.on("languageChanged", apply);
    return () => {
      instance.off("languageChanged", apply);
    };
  }, [instance]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
