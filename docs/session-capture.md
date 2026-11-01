# Session capture — the host's side

The engine turns a played session into a `ReplayFixture` (`SessionLayer.captureSession`,
engine `docs/docs/engine/08-session-capture.md`). The fixture is safe to keep: it carries no
profile id, no unissued id and no undeclared key. Everything else is this server's job under
08 §8, and this document says how the server does it.

## What the server owns (08 §8)

| Obligation                 | Where it lives                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Lawful basis and consent   | A capture is taken only on a named trigger (below), each with its own consent, never in the background |
| Capture-to-account mapping | `session_captures.player_id`, a column beside the fixture, never inside it                             |
| Retention                  | `session_captures.expires_at`, filtered on every read and swept by `maintenance.ts`                    |
| Access control             | `routes/captures.ts`: the capture's owner or an admin, nobody else                                     |

## Triggers

- **Report.** `POST /api/sessions/:id/capture` with `{consent: true}` — the owner reporting a
  problem with their own session. `POST /api/admin/captures` with `{sessionId, consent: true}`
  is an admin acting on a player's report; the capture still belongs to the session's owner.
  Without `consent: true` both answer `400 consent_required` and nothing is captured.
- **Fault.** When a session emits an `error`-severity event (08 §3: today
  `core.deserialize.rejected` and `kind.story-graph.settle.guard_tripped`), `composition.ts`'s
  record sink schedules a capture after the faulting command has released the session. It is
  taken only if the session's owner opted in, and at most once per session
  (`session_captures_one_fault`). A failure is logged by code and never thrown.

Fault consent is an account setting, off by default: `GET`/`POST /api/captures/consent`
(`{faultCapture: boolean}`). `players.fault_capture_consented_at` records when it was given;
withdrawing clears it, and granting again starts a new timestamp. It does not carry over an
account merge — the surviving account's own setting stands.

Every capture goes through `ownedStore.ts`'s `gateCapture` first: ownership, then the content
gate on every epoch the session's history names, the way `branchSession` is gated. A refusal
from `captureSession` (`unknown_session`, `invalid_state`, `unknown_campaign`) is answered as a
typed error through the existing `SessionStoreError` mapping, and nothing is stored.

## Storage

`session_captures` (migration 021):

- `capture_id uuid` — the row key. The fixture's `name` is `capture-<capture_id>`, a random id
  never derived from the session id, the profile or the account (08 §2.1).
- `player_id uuid references players on delete cascade` — the mapping that makes deletion on
  request reach the capture.
- `session_id`, `campaign_id`, `campaign_versions` — so an operator can find a capture, and so
  content deletion can purge the captures that replay through a deleted epoch.
  `campaign_versions` is the fixture's start version plus each adoption target.
- `trigger text` — `report` or `fault`.
- `fixture jsonb` — the `ReplayFixture`, verbatim.
- `created_at`, `expires_at` — `expires_at` is `CAPTURE_RETENTION_DAYS` (default 30, 1 to 3650) after the capture.

## Deletion

- **On request:** `DELETE /api/captures` (every capture of the caller's, expired or not) and
  `DELETE /api/captures/:id`.
- **With the account:** `player_id` cascades.
- **Account merge:** `mergePlayers` repoints captures to the surviving player, like every other
  player-owned table, so a guest's report survives signing in.
- **Content deletion:** `content/deletion.ts`'s purge deletes every capture of a purged session
  and every capture whose `campaign_versions` names a deleted epoch. A capture gets no
  tombstone.
- **Expiry:** reads hide an expired capture at once; `sweepExpiredCaptures` (every API
  maintenance tick, `MIGRATE_ON_START`'s sweep and `maintenance-cli.ts`) deletes it.

## Access

| Route                      | Who                                                          |
| -------------------------- | ------------------------------------------------------------ |
| `GET /api/captures`        | the caller's own captures, summaries only                    |
| `GET /api/captures/:id`    | owner or admin; the whole fixture, `cache-control: no-store` |
| `DELETE /api/captures/:id` | owner or admin                                               |
| `GET /api/admin/captures`  | admin; every unexpired capture, summaries only               |

No route mints a principal: a request with no account gets `403`.

## Rules the code keeps

- The fixture is never logged, never attached to an error response, never sent to a public
  issue (08 §4). Error handling reports the capture id and an error code only, and a database
  error from the insert is replaced before it can reach a log, since Postgres quotes a failing
  row's values in its `detail`.
- Promotion to the engine's committed corpus is manual and reviewed (08 §7). Nothing here
  automates it.

## Decisions

Decided by the owner on 2026-11-01. See CLAUDE.md's decision log for the reasoning.

- Triggers: a player's report (or an admin acting on one), and automatic capture on an
  `error`-severity event.
- Consent: a report carries it in the request; fault capture is an opt-in account setting,
  off by default, recorded with a timestamp.
- Retention window: 30 days, `CAPTURE_RETENTION_DAYS`.
- Who may read: admins and the capture's owner. The owner gets the full fixture, seed
  included — a deliberate departure from 08 §2.1, which warns that the seed lets a player
  predict draws.
