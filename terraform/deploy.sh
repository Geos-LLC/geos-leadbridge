#!/bin/bash
# ============================================================
# LeadBridge — Full Deploy Script
# ============================================================
# Usage: ./deploy.sh
# Prerequisites: aws cli configured, docker, terraform, node
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=========================================="
echo "  LeadBridge — Full Deployment"
echo "=========================================="

# --- Step 1: Terraform apply ---
echo ""
echo "[1/4] Running Terraform..."
cd "$SCRIPT_DIR"

terraform init
terraform plan -out=tfplan
terraform apply tfplan
rm -f tfplan

# Capture outputs
ECR_URL=$(terraform output -raw ecr_repository_url)
S3_BUCKET=$(terraform output -raw frontend_s3_bucket)
CF_DIST_ID=$(terraform output -raw cloudfront_distribution_id)
API_URL=$(terraform output -raw backend_api_url)
FRONTEND_URL=$(terraform output -raw frontend_cloudfront_url)
ECS_CLUSTER=$(terraform output -raw ecs_cluster_name)
ECS_SERVICE=$(terraform output -raw ecs_service_name)
AWS_REGION=$(terraform output -raw 2>/dev/null || echo "us-east-1")

echo "  ECR: $ECR_URL"
echo "  API: $API_URL"

# --- Step 2: Build & push backend Docker image ---
echo ""
echo "[2/4] Building and pushing backend Docker image..."
cd "$PROJECT_ROOT"

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$ECR_URL"

# Build and push (from project root — Dockerfile expects root context)
docker build -t leadbridge-backend .
docker tag leadbridge-backend:latest "$ECR_URL:latest"
docker push "$ECR_URL:latest"

# Force new deployment
aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --force-new-deployment --region us-east-1 > /dev/null

echo "  Backend deployed. Waiting for ECS to stabilize..."
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region us-east-1 2>/dev/null || true

# --- Step 3: Build & deploy frontend ---
echo ""
echo "[3/4] Building and deploying frontend..."
cd "$PROJECT_ROOT/frontend"

# Build with API URL pointing to CloudFront (which proxies /api/* to ALB)
VITE_API_URL="/api" npm run build

# Sync to S3
aws s3 sync dist/ "s3://$S3_BUCKET" --delete

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id "$CF_DIST_ID" --paths "/*" > /dev/null

# --- Step 4: Done ---
echo ""
echo "=========================================="
echo "  Deployment Complete!"
echo "=========================================="
echo ""
echo "  Backend API:  $API_URL"
echo "  Frontend:     $FRONTEND_URL"
echo ""
echo "=========================================="
