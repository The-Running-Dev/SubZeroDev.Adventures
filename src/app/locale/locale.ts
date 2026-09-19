import { createInstance } from "i18next";
import { resources } from "./catalogs";
export type Locale = "en" | "bg";
export const LOCALE_STORAGE_KEY = "subzerodev.play.locale.v1";

export function readLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "bg") return stored;
  } catch {
    /* Storage denial still permits an in-memory choice. */
  }
  return (navigator.languages[0] ?? navigator.language)
    .toLowerCase()
    .startsWith("bg")
    ? "bg"
    : "en";
}

export function createLocaleInstance() {
  const instance = createInstance();
  // Bundled catalogs initialize synchronously and remain available without a network.
  void instance.init({
    resources,
    lng: readLocale(),
    fallbackLng: "en",
    supportedLngs: ["en", "bg"],
    ns: ["common", "titles", "pwa", "shell", "library", "badges", "play"],
    defaultNS: "common",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}
