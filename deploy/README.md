# Adventures deployment (OpenTofu)

Manages the production Adventures stack on the VPS through `modules/app` of SubZeroDev.Infra:
the Portainer Git stack (stack 14, project `subzerodev-adventures`), the Cloudflare tunnel route and DNS
record for `adventures-api.subzerodev.com`, and the GitHub `production` environment (`INFRA_DISPATCH_TOKEN`).

Run everything through `./deploy/tofu.ps1`; it loads credentials from your User-scope environment and the
stack's values from a private var-file outside the repository.

## First adoption

1. In the SubZeroDev.Infra repository, write the var-file from the running stack (prints names only):

   ```powershell
   ./scripts/export-stack-env.ps1 -StackId 14 `
     -SecretNames DB_PASSWORD,GITHUB_CLIENT_SECRET,OIDC_CLIENT_SECRET,DISCUSSIONS_TOKEN `
     -Extra @{ BACKUP_RETENTION_DAYS = '30' } `
     -Out "$HOME\.subzerodev\adventures.tfvars.json"
   ```

   `DB_PASSWORD` must stay exactly what it is: it lives inside the `adventures-db` volume.

2. `./deploy/tofu.ps1 plan`. Expect the stack and the API DNS record to be imported, the stack updated in
   place (adds `ledger-db` and `cloudflared`), the tunnel created, and the GitHub secrets written. Nothing
   is recreated.
3. `./deploy/tofu.ps1 apply`, then check `https://adventures-api.subzerodev.com/readyz`, and a second
   `plan` shows no changes.
4. Delete the old Nginx Proxy Manager host for `adventures-api.subzerodev.com`.

The `import` blocks in `main.tf` can stay: once the resources are in state they do nothing.

## Deploys

A push to `main` builds both images, then the `deploy` job in `container.yml` starts the Infra deploy
workflow with the API image digest. Infra validates it, redeploys the stack and waits until `/readyz`
reports that commit. The frontend rides `:latest` and is pulled by the same redeploy.

## The frontend

`adventures.subzerodev.com` is served by GitHub Pages, so only the API is routed through the tunnel. Moving
the frontend to the VPS means adding `adventures-web` to `routes`, setting the repository variable
`FRONTEND_HOST=vps`, and repointing that DNS record.

## Platform's edge

The `adventures-api` route points at `http://adventures-edge:8080`: Platform's edge in `PassThrough` mode,
its own stack on `proxy-net`, which forwards every path to `adventures-api:8787`. Players keep
`adventures-api.subzerodev.com`, their session cookies and the OIDC `redirect_uri`; the edge forwards
`Cookie`, `Origin` and `Set-Cookie` unchanged and never `Authorization`. Deploys are unchanged: the edge
forwards `/readyz`, so the health check still reads Adventures' own revision.

### Before applying

- The `adventures-edge` stack is applied and healthy: `deploy/adventures-edge` in SubZeroDev.Platform, and
  `GET https://<its health hostname>/health/ready` is `200`. Until then the tunnel would route players to a
  container that does not exist.
- `GameEdge:TrustedProxies` is settled. While it is unset, every anonymous caller reaches the edge from the
  tunnel connector's address and shares one `AbuseLimits` budget (60 requests a minute by default): past
  that, players get `429` and the deploy's `/readyz` polling can be refused too.

### Cutover

1. `./deploy/tofu.ps1 plan`: the only change is the tunnel configuration's `adventures-api` service.
2. `./deploy/tofu.ps1 apply`.
3. At `https://adventures-api.subzerodev.com`: `GET /readyz` is `200`, an API read returns Adventures' own
   answer, and a sign-in sets the session cookie (SubZeroDev.Platform `workloads/game-edge/README.md`,
   "Verifying a deployment").

### Rollback

1. Set the route back to `adventures-api = "http://adventures-api:8787"` in `main.tf`.
2. `./deploy/tofu.ps1 apply`. Only the tunnel route changes; the host, TLS and Adventures do not, so players
   stay signed in.
3. `GET /api/me` at the public host is `200`, and a signed-in player is still signed in. The edge holds no
   state; it can be stopped or left running.

In an emergency the same change can be made on the tunnel in the Cloudflare dashboard. The next `plan` then
shows the drift; commit the route to match before applying anything else.
