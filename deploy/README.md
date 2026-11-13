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
