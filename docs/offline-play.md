# Offline play protocol v1

## Existing seams

The pinned engine's `PortableCampaign` format 2 and `digestPortableCampaign` already
identify content. `shared/campaign-registry.ts` resolves extensions before hydration;
bundles retain that resolved portable rather than shipping unfiltered registry strings.
`createEngine`, `serialize`, `deserialize`, `scene` and `submitAction` supply the local
adapter. Recovery uses the same serialized `GameState` that `StoredSessionRecord.blob`
already stores; its ordered `actionLog` is committed with it. No duplicate game rules.
`server/src/replay.ts` establishes the critical replay rule: original `gameId` must be
injected through `IdSource`, as well as the seed. The normal `RemoteSessionStore` stays
network-only and never falls back after a timeout.

## Support matrix

| Runtime                                          | Offline                    | Evidence                                                                                                                                                                                     |
| ------------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable format 2 story-graph, kind 1.0.0        | Yes, after full validation | `story-graph/campaign.ts` contains text/variables/nodes/achievements only; `kind.ts` has no profileData or host I/O; engine determinism supplies RNG. There are no external playable assets. |
| Resolved story-graph extensions                  | Yes                        | Server's existing merge/validation path produces a single immutable portable with its complete strings.                                                                                      |
| Simulation / world-graph                         | Online only                | Their projection/action input and cross-game behavior need a separate proven offline adapter.                                                                                                |
| Unknown format/kind/runtime or failed validation | Online only                | No optimistic capability flag.                                                                                                                                                               |

## Bundle and runtime retention

Schema 1 bundles include a resolved portable, digest, campaign/version, engine version,
kind version, and a hash-addressed, self-contained runtime module. The frozen module
is generated from the recorded engine submodule commit, reviewed and retained in git.
Both API replay and browser execution use those exact bytes. Builds copy every retained
runtime to the static host and the API image; application updates do not regenerate or
remove them. A runtime upgrade adds a version, never overwrites an old one. Download
validates content and runtime bytes before atomically marking a bundle ready in IndexedDB.
Runtime code is retained with each local bundle/run, so eviction of a service-worker
cache cannot silently select a different engine. Unsupported or missing versions are
explicit errors; raw recovery export remains available.

## Identity, saves and concurrency

A local run stores schema 1, a random local run ID, original gameId, seed, audience
`player`, pinned bundle and runtime, account scope (API origin plus member ID) or device
guest scope, opaque server base, checkpoint when present, serialized state and ordered
actions. Story-graph has no kindProfileData; absence is intentional and pinned.
IndexedDB commits the action log and recovery blob together before showing "Saved on
this device". A Web Lock serializes operations across tabs; a local revision check rejects
a stale tab instead of replaying a second click. No optimistic engine state becomes a save.
Removing a download leaves runs and their runtime/content intact. Run deletion is a
separate explicit action, with export available first.

The last successfully verified member association may unlock local data offline on the
same device; it is never server authorization. Logout clears it and changes the mounted
offline scope; other tabs observe that change. A successful anonymous/member response
replaces it. Guest runs never upload or become another account's runs automatically.

## Server base, replay and receipts

An authorized download creates a server-held immutable bundle grant and opaque fresh-run
base. A prepared online checkpoint additionally records the owned source session's raw
blob and a server-generated lineage UUID. A database trigger changes that UUID on every
source session update, including ABA changes: action count, savedAt, hashes and timestamps
are not used as concurrency tokens.

Sync submits schema, localRunId, idempotency key, bundle grant, exact runtime/content
identity, original gameId/seed, opaque base and the complete ordered action log. Server
ownership is enforced in an owned offline store, using the existing ownership assertion
for checkpoint sessions. The server ignores client result claims and replays with its
retained runtime. A checkpoint's prefix must exactly match its confirmed history.

Validated offline histories and receipts commit together in separate personal archive
tables. The first receipt advances the fresh/checkpoint base to a run-specific UUID;
subsequent syncs compare and rotate it. Reused keys with a different request fail. A lost
response can retry the identical request and receive the original receipt. Row/advisory
locks serialize concurrent requests. Divergent source or archive revisions return a
conflict and preserve both histories; the UI offers retain-local/export, never merging.

An online checkpoint is an explicit fork for offline continuation: it does not overwrite
the live online session or its saves. Its validated history remains separately identified
in the offline archive. This matches the engine's existing independent branch semantics
and avoids smuggling offline accomplishments into online competitive measurements.

## Eligibility

Before replay, all local outcomes are provisional. Successful replay validates narrative
progress, endings and in-run achievements/rewards in the personal offline archive only.
Offline archive runs do not enter platform stats, account badges/achievements, standings,
fastest-ending or any competitive measurement. Replay proves legal transitions, not
honest timing or absence of branch exploration. Separate archive tables make this
exclusion structural: existing online aggregate queries cannot accidentally count them.

## Deployment and recovery

Uses the existing VPS API plus static frontend image and Portainer stack. Apply the normal
migration service before API startup. Foreground sync is explicit and needs no background
sync permission. Quota/write failures leave the prior committed run intact and offer retry
or export; a failed/incomplete download is never ready. Browser data deletion cannot be
undone; export provides a portable backup including the required runtime and bundle.

## Validation

`npm run test:offline` uses a migrated, dedicated `DATABASE_URL`, the built API
(`npm run build --prefix server`), production PWA assets and a persistent Playwright
browser profile. It downloads an existing campaign, blocks outbound requests, starts and
advances it, closes the whole browser, reopens and completes it offline, applies a prompted
app update, then loses a committed sync response and retries. SQL assertions compare the
archive with authoritative pinned replay, require exactly one receipt and unchanged
platform aggregates. It also checks account switching/logout and a 320px Bulgarian screen.
The `offline-e2e` CI job supplies PostgreSQL 17 and the managed Chromium version.

The browser suite exercises failed/incomplete downloads, missing historical code,
quota failure and atomic preservation, multi-tab writers, guest/account boundaries,
download removal and exact retry requests. API integration tests cover malformed and
tampered logs, version mismatches, ownership, ABA lineage conflicts, catalog replacement,
concurrent duplicate requests and rollback when receipt persistence fails.

When adding a runtime, keep its old module, type contract and hash allowlist entry in
both browser and server dispatch. Do not regenerate an already published filename.
Recovery exports are diagnostic backups; v1 does not offer an account-claim or restore
import UI. Keep the original browser data until any manual recovery has been verified.
