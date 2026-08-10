# The player model

What a player is, what follows them from one campaign to the next, and what a campaign
keeps to itself. This is the layer above [issue #8](https://github.com/The-Running-Dev/SubZeroDev.Adventures/issues/8)'s
identity seam — that issue protects how a request resolves to a principal (provider
adapters, `server/src/principal.ts`); this is about what a player accumulates once resolved.

Nothing here is enforced by a single module — it's the shape that falls out of
`server/migrations/`, `server/src/principal.ts`, and `server/src/routes/progress.ts`
together. This document exists so that shape doesn't have to be reconstructed by reading
SQL every time.

## Per-player vs. per-campaign

**Per-player — survives every campaign, forever:**

- `players` (`server/migrations/001_players.sql`): `player_id`, `kind` (`guest` or
  `member`), `display_name`.
- `identities` (`007_identities.sql`): zero or more `(provider, subject)` rows linking a
  sign-in provider account to a `player_id`.
- `auth_sessions` (`003_auth_sessions.sql`): the session cookie's backing row, sha256 of
  the token, 180-day TTL.

**Per-campaign — scoped to one campaign, keyed by `player_id` alongside it:**

- `sessions` (`002_sessions_and_saves.sql`): one row per play attempt. A player can have
  several sessions for the same campaign at once — retries, and branches created by
  `/replay/branch` — that's normal, not a bug.
- `saves` (`002_sessions_and_saves.sql`): checkpoints within a session.
- `achievements` (`004_achievements.sql`): one row per `(player_id, campaign_id,
achievement_id)` unlock.

A guest and a member are the same shape — `kind` only records whether any identity has
ever been linked. Nothing about progress, saves, or achievements depends on it.

## `display_name`'s provenance

Set once, during identity upgrade (`upgradeViaIdentity`, `server/src/principal.ts`), from
whatever the sign-in provider's claims carry:

```ts
const displayName = claims?.name ?? claims?.email;
```

(`server/src/identity/oidc.ts`) — if the provider sends no `name` claim, the player's
`display_name` is their email address. This is worth stating plainly rather than leaving
it as a side effect of a fallback chain: it means an email address can sit in a column
nobody thinks of as holding one. A guest's `display_name` is always `null` — it's only
ever set on upgrade, never guessed at guest creation.

Once set, `display_name` is never overwritten by a later sign-in on the same or a
different provider — both `upgradeViaIdentity` branches use `coalesce(display_name, ...)`
when a merge or an already-linked identity brings a new claimed name along. The first name
a player's identity ever supplied sticks.

## How `/api/progress` derives its numbers

`GET /api/progress` (`server/src/routes/progress.ts`) mixes two aggregations over
`sessions`, deliberately, per campaign:

- **`status` and `stepCount` come from the single most-recently-touched session** —
  `distinct on (campaign_id) ... order by updated_at desc`. "How far am I" means the
  current attempt, and a player mid-retry shouldn't see an older, further-along session's
  numbers just because it exists.
- **`sessionCount`, `firstPlayedAt`, and discovered endings aggregate across every session**
  for that campaign — these describe the whole history, not the current attempt. An ending
  found on an abandoned session three retries ago still counts as discovered.

`endings.total` is the only field in the response sourced from campaign content, via
`endingCountOf` (`shared/campaign-registry.ts`). Everything else in the response is built
from what this player's own sessions actually did.

### Non-goals

- **`firstPlayedAt`/`lastPlayedAt` are a wall-clock span, not playtime.** `GameState`
  carries no timestamps at all (the engine's `core/kernel/types.ts`), so there is no
  "time actually spent playing" to report — only when the earliest and most recent session
  rows were touched. A campaign left open in a background tab for a week reports a week.
- **`endings.discovered` is never sourced from campaign content.** It's built only from
  `ending_id`s this player's own sessions actually produced (`array_agg(distinct ending_id)
filter (where ending_id is not null)`), never from the campaign's full ending list. This is
  what keeps the endings display spoiler-safe — a player can never see how many or which
  endings exist beyond the ones they've found, because `endings.total` is a count, not a
  list.

## Cross-device paths

Two ways a player's progress moves to a second device, both converging on
`mergePlayers` (`server/src/principal.ts`). Both preserve sessions, saves, and — since
[issue #14](https://github.com/The-Running-Dev/SubZeroDev.Adventures/issues/14) —
achievements, colliding an achievement both sides had already unlocked down to one row
rather than failing the merge.

**Sign in on a second device** (`upgradeViaIdentity`, driven by
`server/src/routes/identity.ts`'s OAuth callback):

- If `(provider, subject)` has never been linked to any player, the current guest is
  upgraded in place — same `player_id`, nothing merged, nothing lost by construction.
- If that identity is already linked to an existing player, the guest on this device is
  merged into the existing account (`mergePlayers(pool, guestPlayerId, playerId)`) and the
  guest's row is deleted. The guest's progress moves over; the guest identity itself
  doesn't survive as a separate account.
- Cost: requires trusting a sign-in provider. No recovery mechanism beyond however that
  provider handles account recovery.

**Redeem a transfer code** (`server/src/routes/transfer.ts`), for a player who doesn't want
to sign in anywhere:

- One device (`/api/transfer/create`) mints a 40-bit Crockford base32 code (`XXXX-XXXX`),
  hashed at rest, single-use, 15-minute TTL.
- A second device redeems it (`/api/transfer/redeem`): the _redeeming_ device's guest
  progress merges onto the code-issuing player
  (`mergePlayers(pool, currentPlayerId, sourcePlayerId)`), and the redeeming device's guest
  row is deleted.
- Refused if the redeeming device is already a signed-in member (`already_linked_account`)
  — merging a real account away on a code redemption is the one outcome here that can't be
  undone, so it's blocked rather than risked.
- Cost: lose the code, lose the transfer — there is no recovery path, and it expires in 15
  minutes. The tradeoff mirrors the identity-upgrade merge case, without needing a
  provider.

## The public ranking

`GET /api/ranking` (`server/src/ranking.ts`, `server/src/platform-baselines.ts`'s
`publicProfileTotals`) lists every player with `profile_public = true` and a minted
`profile_slug`, ordered by a composite Absurdity Index. A private player is simply absent
from the response — there's no "hidden" row, no rank held in reserve, nothing to un-hide
later. Like `GET /api/profile/:slug`, it reads only `profile_slug`, never `player_id`;
`player_id` stays opaque outside `/api/me` on this route too.

One term of the index — rejected moves, `sum(greatest(attempt_counter - step_count, 0))`
— reuses `attempt_counter`, which is dual-purposed as `sessions`' optimistic-lock version
(bumped on every write, not just a rejected move) rather than a true rejected-move
counter. Every badge that reads it (`server/src/badges.ts`) uses a deliberately loose
threshold to absorb that noise; a ranking has no threshold to loosen, so two players can
end up ordered partly by how often they saved and loaded, not just by what they did in
the story. Weighted below badge count in the formula, shown as its own column rather than
folded silently into the total, and disclosed on the page itself — accepted, not hidden.

## What's still open

Unowned resources passing the ownership check
([issue #7](https://github.com/The-Running-Dev/SubZeroDev.Adventures/issues/7)) isn't
settled here because it's being decided elsewhere. It doesn't change the shape described
above — it's about how a request reaches a principal in the first place, which is issue
#8's territory, not this document's.
