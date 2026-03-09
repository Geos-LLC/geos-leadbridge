# ============================================================
# LeadBridge — Terraform Variables
# ============================================================

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "leadbridge"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
  default     = "prod"
}

# --- Networking ---

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to use"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# --- Backend (ECS) ---

variable "backend_cpu" {
  description = "Fargate task CPU units (512 = 0.5 vCPU)"
  type        = number
  default     = 512
}

variable "backend_memory" {
  description = "Fargate task memory in MB"
  type        = number
  default     = 1024
}

variable "backend_desired_count" {
  description = "Number of backend task instances"
  type        = number
  default     = 1
}

variable "backend_container_port" {
  description = "Port the backend container listens on"
  type        = number
  default     = 3000
}

# --- Database (RDS) ---

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.small"
}

variable "db_password" {
  description = "RDS PostgreSQL master password"
  type        = string
  sensitive   = true
}

variable "db_username" {
  description = "RDS PostgreSQL master username"
  type        = string
  default     = "leadbridge"
}

variable "db_name" {
  description = "RDS PostgreSQL database name"
  type        = string
  default     = "leadbridge"
}

variable "skip_final_snapshot" {
  description = "Skip final DB snapshot on destroy"
  type        = bool
  default     = true
}

# --- Auth ---

variable "jwt_secret" {
  description = "JWT signing secret"
  type        = string
  sensitive   = true
}

variable "jwt_expires_in" {
  description = "JWT expiration duration"
  type        = string
  default     = "7d"
}

variable "encryption_key" {
  description = "32-character encryption key for sensitive data"
  type        = string
  sensitive   = true
}

# --- Thumbtack ---

variable "thumbtack_client_id" {
  description = "Thumbtack OAuth client ID"
  type        = string
  default     = ""
}

variable "thumbtack_client_secret" {
  description = "Thumbtack OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "thumbtack_redirect_uri" {
  description = "Thumbtack OAuth redirect URI"
  type        = string
  default     = ""
}

variable "thumbtack_webhook_secret" {
  description = "Thumbtack webhook signing secret"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Yelp ---

variable "yelp_api_key" {
  description = "Yelp API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "yelp_client_id" {
  description = "Yelp client ID"
  type        = string
  default     = ""
}

variable "yelp_client_secret" {
  description = "Yelp client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "yelp_webhook_secret" {
  description = "Yelp webhook secret"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Sigcore (Telephony Middleware) ---

variable "sigcore_api_url" {
  description = "Sigcore API base URL"
  type        = string
  default     = "https://sigcore-production.up.railway.app"
}

variable "sigcore_api_key" {
  description = "Sigcore workspace API key"
  type        = string
  sensitive   = true
}

variable "sigcore_call_connect_webhook_secret" {
  description = "HMAC secret for verifying Sigcore call-connect webhooks"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Stripe ---

variable "stripe_secret_key" {
  description = "Stripe secret key"
  type        = string
  sensitive   = true
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_price_starter" {
  description = "Stripe Price ID for Starter plan"
  type        = string
  default     = ""
}

variable "stripe_price_pro" {
  description = "Stripe Price ID for Pro plan"
  type        = string
  default     = ""
}

variable "stripe_price_enterprise" {
  description = "Stripe Price ID for Enterprise plan"
  type        = string
  default     = ""
}

variable "stripe_price_own_number" {
  description = "Stripe Price ID for dedicated phone number add-on"
  type        = string
  default     = ""
}

# --- Email (EmailJS) ---

variable "emailjs_public_key" {
  description = "EmailJS public key"
  type        = string
  default     = ""
}

variable "emailjs_private_key" {
  description = "EmailJS private key"
  type        = string
  sensitive   = true
  default     = ""
}
