import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTranslation } from "react-i18next";
import { LocaleProvider } from "../providers/LocaleProvider";
import { resources } from "./catalogs";
import { createLocaleInstance, LOCALE_STORAGE_KEY, readLocale } from "./locale";
import { useLocale } from "./useLocale";
import { ApiError } from "../../api/client";
import { ResourceState } from "../../components/ResourceState";

afterEach(() => vi.restoreAllMocks());

function flatten(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      typeof child === "string"
        ? [[prefix + key, child]]
        : Object.entries(flatten(child, `${prefix}${key}.`)),
    ),
  );
}

function Probe() {
  const { t } = useTranslation();
  const { locale, changeLocale, number, date, relativeTime } = useLocale();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => void changeLocale(locale === "en" ? "bg" : "en")}>
        Switch
      </button>
      <input
        aria-label="draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {open && (
        <div role="dialog">
          <button onClick={() => setOpen(false)}>{t("retry")}</button>
        </div>
      )}
      <p>{t("items", { count: 2 })}</p>
      <output>
        {number(1234.5)} | {date("2026-09-19T12:00:00Z")} |{" "}
        {relativeTime(-1, "day")}
      </output>
      <ResourceState
        state="error"
        error={new ApiError(503, "network_error", "raw server English")}
      />
    </>
  );
}

describe("locale foundation", () => {
  it("keeps key, interpolation and plural parity across both catalogs", () => {
    const en = flatten(resources.en),
      bg = flatten(resources.bg);
    expect(Object.keys(bg).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en))
      expect(bg[key].match(/{{\w+}}/g) ?? []).toEqual(
        en[key].match(/{{\w+}}/g) ?? [],
      );
    for (const locale of ["en", "bg"] as const) {
      for (const form of new Intl.PluralRules(locale).resolvedOptions()
        .pluralCategories)
        expect(resources[locale].common).toHaveProperty(`items_${form}`);
    }
  });

  it("uses Bulgarian browser preference only when there is no saved choice", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["bg-BG", "en"]);
    expect(readLocale()).toBe("bg");
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    expect(readLocale()).toBe("en");
    localStorage.setItem(LOCALE_STORAGE_KEY, "invalid");
    expect(readLocale()).toBe("bg");
  });

  it("switches a form, open dialog, plurals and errors offline without losing state, then persists on remount", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network blocked"));
    const view = render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    );
    const input = screen.getByRole("textbox", { name: "draft" });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(input, { target: { value: "unfinished campaign" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await screen.findByRole("button", { name: "Опитай отново" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(input).toHaveValue("unfinished campaign");
    expect(screen.getByText("2 елемента")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Няма връзка със сървъра",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "raw server English",
    );
    await waitFor(() => expect(document.documentElement.lang).toBe("bg"));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("bg");
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: "Опитай отново" })).toBeVisible();
  });

  it("supports English fallback for an unexpected missing Bulgarian translation", async () => {
    const instance = createLocaleInstance();
    instance.addResourceBundle("en", "fallback-test", {
      example: "Fallback text",
    });
    await instance.changeLanguage("bg");
    expect(instance.t("example", { ns: "fallback-test" })).toBe(
      "Fallback text",
    );
  });
});
