import { ApiError, request } from "../api/client";
import { useOnline } from "../pwa/usePwa";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { signInUrl, signOut, type Identity } from "./identity";

interface AccountPanelProps {
  readonly apiUrl: string;
  readonly identity: Identity;
  readonly loading: boolean;
  readonly authError: string | null;
  readonly onChanged: () => void;
  readonly isAdmin: boolean;
  /** Whether there's anywhere for "Profile" to link to -- a signed-in-or-guest player on
   *  a deployment with a backend. Hidden without it, same as the page itself. */
  readonly profileAvailable: boolean;
}

/**
 * The account control in the global header (`Header.tsx`): an operator sigil that opens
 * everything account-shaped -- who you are, a link to your profile, sign in or out, and
 * device transfer. "Disk library" and "Standings" are peer nav items in the header
 * itself now, not menu entries here -- this menu is what's specific to *this* player's
 * identity.
 *
 * The sigil is a single glyph rather than the display name because that name is
 * whatever the provider hands back, commonly an email address, and an email is both too
 * long for a header row and more of the player's identity than a public page needs on
 * permanent display. The full name still opens the menu's first line, and the button's
 * accessible name carries it too, so nothing is only available visually.
 *
 * Guest -> "Sign In" plus a quiet note that progress otherwise lives only in this
 * browser, and a device-transfer code for anyone who doesn't want to sign in at all
 * (server/src/routes/transfer.ts). Signed in -> name and sign out. "Sign In" is the
 * generic OIDC slot (identity.ts's `signInUrl`, server/src/identity/oidc.ts) --
 * deliberately not labeled with a provider name since which one it is is a deployment
 * config choice, not something a player needs to know. A signed-in player is generically
 * `identity.kind === "member"` regardless of which provider they linked.
 */
export function AccountPanel({
  apiUrl,
  identity,
  loading,
  authError,
  onChanged,
  isAdmin,
  profileAvailable,
}: AccountPanelProps) {
  const { t, i18n } = useTranslation("account");
  const online = useOnline();
  const [logoutError, setLogoutError] = useState(false);
  /* A failed sign-in round trip is reported inside the menu, so it opens itself rather
     than leaving the message behind a click nobody knows to make. */
  const [open, setOpen] = useState(Boolean(authError));
  const [transferOpen, setTransferOpen] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (loading) return <div className="account-menu" aria-hidden="true" />;

  async function createTransferCode(): Promise<void> {
    setBusy(true);
    setTransferMessage(null);
    try {
      const body = await request<{ code: string }>(
        apiUrl,
        "/api/transfer/create",
        { method: "POST" },
      );
      setIssuedCode(body.code);
    } catch {
      setTransferMessage("createFailed");
    } finally {
      setBusy(false);
    }
  }

  async function redeemTransferCode(): Promise<void> {
    setBusy(true);
    setTransferMessage(null);
    try {
      await request(apiUrl, "/api/transfer/redeem", {
        method: "POST",
        body: { code: redeemInput },
      });
      setRedeemInput("");
      setTransferOpen(false);
      onChanged();
    } catch (error) {
      setTransferMessage(
        error instanceof ApiError && error.code === "invalid_or_expired_code"
          ? "invalidCode"
          : error instanceof ApiError && error.code === "already_linked_account"
            ? "alreadyLinked"
            : "redeemFailed",
      );
    } finally {
      setBusy(false);
    }
  }

  const member = identity.kind === "member";
  const name = identity.displayName ?? (member ? t("player") : t("guest"));
  const label = member ? t("signedIn", { name }) : t("playingGuest");

  return (
    <>
      {isAdmin && (
        <Link className="system-bar-link" to="/?admin">
          {t("admin")}
        </Link>
      )}
      <div className="account-menu" ref={menu}>
        <button
          className={`account-sigil ${open ? "is-open" : ""}`}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">{sigilFor(name, member)}</span>
          <span className="sr-only">{t("menu", { label })}</span>
        </button>
        {open && (
          <div className="account-dropdown">
            <p className="account-dropdown-name">{label}</p>
            {authError && (
              <p className="account-error" role="alert">
                {t(
                  i18n.exists(`account:${authError}`)
                    ? authError
                    : "oauth_token_exchange_failed",
                )}
              </p>
            )}
            {logoutError && <p role="alert">{t("logoutFailed")}</p>}
            {profileAvailable && (
              <Link
                className="cabinet-button"
                to="/profile"
                onClick={() => setOpen(false)}
              >
                {t("profile")}
              </Link>
            )}
            {member ? (
              <button
                className="cabinet-button"
                disabled={!online || busy}
                onClick={() => {
                  setBusy(true);
                  setLogoutError(false);
                  void signOut(apiUrl)
                    .then(onChanged)
                    .catch(() => setLogoutError(true))
                    .finally(() => setBusy(false));
                }}
              >
                {t("signOut")}
              </button>
            ) : (
              <>
                <p className="account-note">{t("guestNote")}</p>
                {identity.signInProvider && (
                  <a
                    className="cabinet-button primary"
                    href={signInUrl(apiUrl, identity.signInProvider)}
                  >
                    {t("signIn")}
                  </a>
                )}
                <button
                  className="cabinet-button"
                  onClick={() => setTransferOpen((isOpen) => !isOpen)}
                >
                  {t("transfer")}
                </button>
              </>
            )}
            {transferOpen && (
              <div className="account-transfer">
                <p className="account-transfer-intro">{t("transferIntro")}</p>

                <div className="account-transfer-section">
                  <p className="account-transfer-label">{t("sendProgress")}</p>
                  {issuedCode ? (
                    <p className="account-transfer-code">
                      {t("enterCode", { code: issuedCode })}
                    </p>
                  ) : (
                    <button
                      className="cabinet-button"
                      disabled={!online || busy}
                      onClick={() => void createTransferCode()}
                    >
                      {t("getCode")}
                    </button>
                  )}
                </div>

                <div className="account-transfer-section">
                  <label
                    className="account-transfer-label"
                    htmlFor="transfer-code-input"
                  >
                    {t("bringProgress")}
                  </label>
                  <div className="account-transfer-redeem">
                    <input
                      id="transfer-code-input"
                      value={redeemInput}
                      onChange={(event) => setRedeemInput(event.target.value)}
                      placeholder="XXXX-XXXX"
                    />
                    <button
                      className="cabinet-button"
                      disabled={!online || busy || !redeemInput.trim()}
                      onClick={() => void redeemTransferCode()}
                    >
                      {t("redeem")}
                    </button>
                  </div>
                </div>

                {transferMessage && (
                  <p className="account-error">{t(transferMessage)}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One glyph for the header button: the display name's first letter, or a guest mark. */
function sigilFor(name: string, member: boolean): string {
  if (!member) return "?";
  return /\p{L}|\p{N}/u.exec(name)?.[0]?.toUpperCase() ?? "@";
}
