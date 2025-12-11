# PowerShell API Testing Script for Thumbtack Bridge
# This script tests all the main API endpoints

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Thumbtack Bridge API Testing" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Base URL
$baseUrl = "http://localhost:3000"

# 1. Register a new user
Write-Host "1. Testing User Registration..." -ForegroundColor Yellow
$registerBody = @{
    email = "demo@example.com"
    password = "SecurePass123!"
    name = "Demo User"
} | ConvertTo-Json

try {
    $registerResponse = Invoke-RestMethod -Uri "$baseUrl/api/auth/register" `
        -Method Post `
        -ContentType "application/json" `
        -Body $registerBody

    Write-Host "✓ User registered successfully!" -ForegroundColor Green
    Write-Host "  User ID: $($registerResponse.user.id)" -ForegroundColor Gray
    Write-Host "  Email: $($registerResponse.user.email)" -ForegroundColor Gray
    Write-Host ""

    # Save token for subsequent requests
    $token = $registerResponse.token

} catch {
    if ($_.Exception.Response.StatusCode -eq 409) {
        Write-Host "✓ User already exists, logging in instead..." -ForegroundColor Yellow

        # Login instead
        $loginBody = @{
            email = "demo@example.com"
            password = "SecurePass123!"
        } | ConvertTo-Json

        $loginResponse = Invoke-RestMethod -Uri "$baseUrl/api/auth/login" `
            -Method Post `
            -ContentType "application/json" `
            -Body $loginBody

        $token = $loginResponse.token
        Write-Host "✓ Logged in successfully!" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host "✗ Registration failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# 2. Get user profile
Write-Host "2. Testing Get Profile..." -ForegroundColor Yellow
try {
    $headers = @{
        "Authorization" = "Bearer $token"
    }

    $profileResponse = Invoke-RestMethod -Uri "$baseUrl/api/auth/profile" `
        -Method Get `
        -Headers $headers

    Write-Host "✓ Profile retrieved successfully!" -ForegroundColor Green
    Write-Host "  Name: $($profileResponse.name)" -ForegroundColor Gray
    Write-Host "  Email: $($profileResponse.email)" -ForegroundColor Gray
    Write-Host "  Platforms connected: $($profileResponse.platforms.Count)" -ForegroundColor Gray
    Write-Host ""

} catch {
    Write-Host "✗ Get profile failed: $($_.Exception.Message)" -ForegroundColor Red
}

# 3. Get Thumbtack OAuth URL
Write-Host "3. Testing Thumbtack OAuth URL..." -ForegroundColor Yellow
try {
    $authUrlResponse = Invoke-RestMethod -Uri "$baseUrl/api/v1/thumbtack/auth/url" `
        -Method Get `
        -Headers $headers

    Write-Host "✓ OAuth URL generated successfully!" -ForegroundColor Green
    Write-Host "  Auth URL: $($authUrlResponse.authUrl)" -ForegroundColor Gray
    Write-Host ""

} catch {
    Write-Host "✗ Get OAuth URL failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Note: Make sure THUMBTACK_CLIENT_ID is configured in .env" -ForegroundColor Yellow
    Write-Host ""
}

# 4. Get all leads (will be empty until Thumbtack is connected)
Write-Host "4. Testing Get All Leads..." -ForegroundColor Yellow
try {
    $leadsResponse = Invoke-RestMethod -Uri "$baseUrl/api/v1/leads" `
        -Method Get `
        -Headers $headers

    Write-Host "✓ Leads retrieved successfully!" -ForegroundColor Green
    Write-Host "  Total leads: $($leadsResponse.Count)" -ForegroundColor Gray
    Write-Host ""

} catch {
    Write-Host "✗ Get leads failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
}

# 5. Get webhook events
Write-Host "5. Testing Webhook Events..." -ForegroundColor Yellow
try {
    $webhooksResponse = Invoke-RestMethod -Uri "$baseUrl/api/webhooks/events" `
        -Method Get `
        -Headers $headers

    Write-Host "✓ Webhook events retrieved successfully!" -ForegroundColor Green
    Write-Host "  Total events: $($webhooksResponse.events.Count)" -ForegroundColor Gray
    Write-Host ""

} catch {
    Write-Host "✗ Get webhook events failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "API Testing Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Your JWT Token (save this for manual testing):" -ForegroundColor Yellow
Write-Host $token -ForegroundColor Gray
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Cyan
Write-Host "1. Update THUMBTACK_CLIENT_ID in .env with your Thumbtack credentials" -ForegroundColor White
Write-Host "2. Visit the OAuth URL above to connect your Thumbtack account" -ForegroundColor White
Write-Host "3. Start receiving leads and messages!" -ForegroundColor White
Write-Host ""
