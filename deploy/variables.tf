variable "state_passphrase" {
  description = "Encrypts the state and plans stored in R2."
  type        = string
  sensitive   = true
}

variable "portainer_url" {
  type    = string
  default = "https://containers.subzerodev.com"
}

variable "portainer_api_key" {
  type      = string
  sensitive = true
}

variable "cf_access_client_id" {
  description = "Cloudflare Access service token in front of Portainer."
  type        = string
  sensitive   = true
}

variable "cf_access_client_secret" {
  type      = string
  sensitive = true
}

variable "dispatch_token" {
  description = "Token with Actions write on the Infra repository only; the deploy job uses it to start the Infra deploy workflow."
  type        = string
  sensitive   = true
}

variable "initial_image" {
  description = "API image applied when the stack is imported, pinned by digest. Deploys own it afterwards."
  type        = string
  default     = "ghcr.io/the-running-dev/adventures-api@sha256:00e015f32e5a3eece8c8ab46f2631ede1f1463845e5257e6230fe3d7c3be04cf"
}

variable "env" {
  description = "Plain stack values read from the running stack (private var-file)."
  type        = map(string)
}

variable "secrets" {
  description = "Secret stack values read from the running stack (private var-file)."
  type        = map(string)
  sensitive   = true

  validation {
    condition     = alltrue([for k in ["DB_PASSWORD", "OIDC_CLIENT_SECRET"] : contains(keys(var.secrets), k)])
    error_message = "secrets needs DB_PASSWORD (it must match the adventures-db volume) and OIDC_CLIENT_SECRET."
  }
}
