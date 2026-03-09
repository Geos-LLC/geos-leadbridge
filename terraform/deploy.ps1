# ============================================================
# LeadBridge — Full Deploy Script (PowerShell)
# ============================================================
# Usage: .\deploy.ps1
# Prerequisites: aws cli configured, docker, terraform, node
# ============================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  LeadBridge - Full Deployment" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# --- Step 1: Terraform apply ---
Write-Host ""
Write-Host "[1/4] Running Terraform..." -ForegroundColor Yellow
Set-Location $ScriptDir

terraform init
if ($LASTEXITCODE -ne 0) { throw "terraform init failed" }

terraform plan -out=tfplan
if ($LASTEXITCODE -ne 0) { throw "terraform plan failed" }

terraform apply tfplan
if ($LASTEXITCODE -ne 0) { throw "terraform apply failed" }

Remove-Item -Force tfplan -ErrorAction SilentlyContinue

# Capture outputs
$ECR_URL = terraform output -raw ecr_repository_url
$S3_BUCKET = terraform output -raw frontend_s3_bucket
$CF_DIST_ID = terraform output -raw cloudfront_distribution_id
$API_URL = terraform output -raw backend_api_url
$FRONTEND_URL = terraform output -raw frontend_cloudfront_url
$ECS_CLUSTER = terraform output -raw ecs_cluster_name
$ECS_SERVICE = terraform output -raw ecs_service_name

Write-Host "  ECR: $ECR_URL" -ForegroundColor Green
Write-Host "  API: $API_URL" -ForegroundColor Green

# --- Step 2: Build & push backend Docker image ---
Write-Host ""
Write-Host "[2/4] Building and pushing backend Docker image..." -ForegroundColor Yellow
Set-Location $ProjectRoot

# Login to ECR
$ecrPassword = aws ecr get-login-password --region us-east-1
docker login --username AWS --password $ecrPassword $ECR_URL
if ($LASTEXITCODE -ne 0) { throw "Docker ECR login failed" }

# Build and push (from project root)
docker build -t leadbridge-backend .
if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }

docker tag leadbridge-backend:latest "${ECR_URL}:latest"
docker push "${ECR_URL}:latest"
if ($LASTEXITCODE -ne 0) { throw "Docker push failed" }

# Force new deployment
aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE --force-new-deployment --region us-east-1 | Out-Null
Write-Host "  Backend deployed. ECS will roll out the new version..." -ForegroundColor Green

# --- Step 3: Build & deploy frontend ---
Write-Host ""
Write-Host "[3/4] Building and deploying frontend..." -ForegroundColor Yellow
Set-Location "$ProjectRoot\frontend"

# Install deps if needed
if (-not (Test-Path "node_modules")) {
    npm install
}

# Build with API URL
$env:VITE_API_URL = "/api"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

# Sync to S3
aws s3 sync dist/ "s3://$S3_BUCKET" --delete
if ($LASTEXITCODE -ne 0) { throw "S3 sync failed" }

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id $CF_DIST_ID --paths "/*" | Out-Null

# --- Step 4: Done ---
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Deployment Complete!" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Backend API:  $API_URL" -ForegroundColor Green
Write-Host "  Frontend:     $FRONTEND_URL" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan

# Return to original directory
Set-Location $ScriptDir
