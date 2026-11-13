# Adopts the existing Adventures stack (Portainer stack 14) into OpenTofu through modules/app of
# SubZeroDev.Infra: Cloudflare tunnel and DNS for adventures-api, the Portainer Git stack and the GitHub
# `production` environment. Run through deploy/tofu.ps1; see deploy/README.md.
terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "5.28.1" }
    portainer  = { source = "portainer/portainer", version = "2.2.0" }
    github     = { source = "integrations/github", version = "6.13.0" }
    random     = { source = "hashicorp/random", version = "3.9.1" }
    http       = { source = "hashicorp/http", version = "3.6.3" }
  }

  # Bucket, key and endpoint come from backend.hcl (Git-ignored); R2 keys from AWS_ACCESS_KEY_ID and
  # AWS_SECRET_ACCESS_KEY, which tofu.ps1 maps from the R2_* variables.
  backend "s3" {
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}

provider "cloudflare" {} # CLOUDFLARE_API_TOKEN

provider "github" {
  owner = "The-Running-Dev" # GITHUB_TOKEN
}

provider "portainer" {
  endpoint = var.portainer_url
  api_key  = var.portainer_api_key
  custom_headers = {
    "CF-Access-Client-Id"     = var.cf_access_client_id
    "CF-Access-Client-Secret" = var.cf_access_client_secret
  }
}

module "app" {
  source = "git::https://github.com/The-Running-Dev/SubZeroDev.Infra.git//modules/app?ref=v2.0.0"

  name          = "adventures" # The existing Portainer stack name; the compose project (volume names) is set by `name:` in docker-compose.yml
  repository    = "The-Running-Dev/SubZeroDev.Adventures"
  compose_files = ["docker-compose.yml", "compose.tunnel.yaml"]

  # Only the API goes through the tunnel. adventures.subzerodev.com stays on GitHub Pages until
  # FRONTEND_HOST is `vps` (container.yml), so its DNS record is not managed here.
  routes = { adventures-api = "http://adventures-api:8787" }

  image = {
    variable = "ADVENTURES_API_IMAGE"
    initial  = var.initial_image # applied once at import; deploys own the image afterwards
  }

  # Names and values come from the private var-file that tofu.ps1 loads (scripts/export-stack-env.ps1 in the
  # Infra repository writes it from the running stack): GITHUB_CLIENT_ID, OIDC_*, ADMIN_SUBJECTS,
  # DISCUSSIONS_*, BACKUP_RETENTION_DAYS ...
  env = var.env

  # DB_PASSWORD (must stay what the adventures-db volume holds), GITHUB_CLIENT_SECRET, OIDC_CLIENT_SECRET,
  # DISCUSSIONS_TOKEN.
  secrets = var.secrets

  # The deletion ledger's database password, created once. adventures-ledger starts empty with it.
  generated = ["LEDGER_DB_PASSWORD"]

  health_path   = "/readyz"
  portainer_url = var.portainer_url
  portainer_credentials = {
    api_key              = var.portainer_api_key
    access_client_id     = var.cf_access_client_id
    access_client_secret = var.cf_access_client_secret
  }
  dispatch_token  = var.dispatch_token # stored as INFRA_DISPATCH_TOKEN; starts the Infra deploy workflow
  git_credentials = null               # the repository is public
  registry_ids    = [1]                # the shared ghcr.io registry
}

# Adopt what already exists, so nothing is recreated.
import {
  to = module.app.portainer_stack.this
  id = "3-14-standalone-repository" # <endpoint>-<stack>-<type>-<method>
}

import {
  to = module.app.cloudflare_dns_record.route["adventures-api"]
  id = "e958380ca90211dfa0fc68c5c2df277f/3e88076223863a1e455fc166533c33df"
}

output "public_url" {
  value = "https://adventures-api.subzerodev.com"
}
