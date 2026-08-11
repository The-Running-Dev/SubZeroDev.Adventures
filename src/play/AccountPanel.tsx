import { useEffect, useRef, useState } from "react";
import { signInUrl, signOut, type Identity } from "./identity";

const AUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  oauth_not_configured: "Sign-in isn't set up on this deployment yet.",
  invalid_oauth_state: "That sign-in link expired. Try again.",
  oauth_token_exchange_failed: "Sign-in failed. Try again.",
};

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
      const response = await fetch(`${apiUrl}/api/transfer/create`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("create failed");
      const body = (await response.json()) as { code: string };
      setIssuedCode(body.code);
    } catch {
      setTransferMessage("Couldn't create a transfer code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function redeemTransferCode(): Promise<void> {
    setBusy(true);
    setTransferMessage(null);
    try {
      const response = await fetch(`${apiUrl}/api/transfer/redeem`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: redeemInput }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          { error?: { code?: string } } | undefined;
        setTransferMessage(
          body?.error?.code === "invalid_or_expired_code"
            ? "That code is invalid or has expired."
            : body?.error?.code === "already_linked_account"
              ? "Sign out of this account before redeeming a transfer code."
              : "Couldn't redeem that code. Try again.",
        );
        return;
      }
      setRedeemInput("");
      setTransferOpen(false);
      onChanged();
    } catch {
      setTransferMessage("Couldn't redeem that code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const member = identity.kind === "member";
  const name = identity.displayName ?? (member ? "player" : "Guest operator");
  const label = member ? `Signed in as ${name}` : "Playing as a guest";

  return (
    <>
      {isAdmin && (
        <a className="system-bar-link" href="/?admin">
          Admin
        </a>
      )}
      <div className="account-menu" ref={menu}>
        <button
          className={`account-sigil ${open ? "is-open" : ""}`}
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">{sigilFor(name, member)}</span>
          <span className="sr-only">{label} -- account menu</span>
        </button>
        {open && (
          <div className="account-dropdown">
            <p className="account-dropdown-name">{label}</p>
            {authError && (
              <p className="account-error" role="alert">
                {AUTH_ERROR_MESSAGES[authError] ?? "Sign-in failed. Try again."}
              </p>
            )}
            {profileAvailable && (
              <a
                className="cabinet-button"
                href="/profile"
                onClick={() => setOpen(false)}
              >
                Profile
              </a>
            )}
            {member ? (
              <button
                className="cabinet-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void signOut(apiUrl).finally(() => {
                    setBusy(false);
                    onChanged();
                  });
                }}
              >
                Sign out
              </button>
            ) : (
              <>
                <p className="account-note">
                  Progress lives only in this browser until you sign in.
                </p>
                {identity.signInProvider && (
                  <a
                    className="cabinet-button primary"
                    href={signInUrl(apiUrl, identity.signInProvider)}
                  >
                    Sign In
                  </a>
                )}
                <button
                  className="cabinet-button"
                  onClick={() => setTransferOpen((isOpen) => !isOpen)}
                >
                  Transfer progress
                </button>
              </>
            )}
            {transferOpen && (
              <div className="account-transfer">
                <p className="account-transfer-intro">
                  Playing on a second device without signing in? A code moves
                  this browser's progress there, or the reverse.
                </p>

                <div className="account-transfer-section">
                  <p className="account-transfer-label">
                    Send this device's progress elsewhere
                  </p>
                  {issuedCode ? (
                    <p className="account-transfer-code">
                      Enter <strong>{issuedCode}</strong> on the other device
                      within 15 minutes.
                    </p>
                  ) : (
                    <button
                      className="cabinet-button"
                      disabled={busy}
                      onClick={() => void createTransferCode()}
                    >
                      Get a code
                    </button>
                  )}
                </div>

                <div className="account-transfer-section">
                  <label
                    className="account-transfer-label"
                    htmlFor="transfer-code-input"
                  >
                    Bring another device's progress here
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
                      disabled={busy || !redeemInput.trim()}
                      onClick={() => void redeemTransferCode()}
                    >
                      Redeem
                    </button>
                  </div>
                </div>

                {transferMessage && (
                  <p className="account-error">{transferMessage}</p>
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
