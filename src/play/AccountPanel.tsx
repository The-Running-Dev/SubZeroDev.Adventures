import { useState } from "react";
import { supabaseSignInUrl, signOut, type Identity } from "./identity";

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
}

/**
 * Guest -> "Sign In" plus a quiet note that progress otherwise lives only in this browser,
 * and a device-transfer code for anyone who doesn't want to sign in at all
 * (server/src/routes/transfer.ts). Signed in -> name and sign out. This is the one piece
 * of the guest-first design (server/src/principal.ts) that previously had no UI at all --
 * the OAuth routes and transfer codes existed and worked, but nothing on the page ever
 * told a player they were playing as an anonymous cookie. "Sign In" is the generic OIDC
 * slot (identity.ts's `supabaseSignInUrl`, server/src/identity/oidc.ts) -- deliberately not
 * labeled with a provider name since which one it is is a deployment config choice, not
 * something a player needs to know. A signed-in player is generically
 * `identity.kind === "member"` regardless of which provider they linked.
 */
export function AccountPanel({
  apiUrl,
  identity,
  loading,
  authError,
  onChanged,
}: AccountPanelProps) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [redeemInput, setRedeemInput] = useState("");
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <div className="account-panel" aria-hidden="true" />;

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

  return (
    <div className="account-panel">
      {authError && (
        <p className="account-error" role="alert">
          {AUTH_ERROR_MESSAGES[authError] ?? "Sign-in failed. Try again."}
        </p>
      )}
      {identity.kind === "member" ? (
        <div className="account-chip">
          <span>Signed in as {identity.displayName ?? "player"}</span>
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
        </div>
      ) : (
        <div className="account-chip">
          <span>
            Playing as a guest -- progress lives only in this browser.
          </span>
          <a className="cabinet-button" href={supabaseSignInUrl(apiUrl)}>
            Sign In
          </a>
          <button
            className="cabinet-button"
            onClick={() => setTransferOpen((open) => !open)}
          >
            Move to another device
          </button>
        </div>
      )}
      {transferOpen && (
        <div className="account-transfer">
          {issuedCode ? (
            <p>
              Enter <strong>{issuedCode}</strong> on the other device within 15
              minutes.
            </p>
          ) : (
            <button
              className="cabinet-button"
              disabled={busy}
              onClick={() => void createTransferCode()}
            >
              Get a code for this device's progress
            </button>
          )}
          <div className="account-transfer-redeem">
            <label htmlFor="transfer-code-input">
              Have a code from another device?
            </label>
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
          {transferMessage && (
            <p className="account-error">{transferMessage}</p>
          )}
        </div>
      )}
    </div>
  );
}
