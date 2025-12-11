# PowerShell API Testing Guide

Since you're on Windows, here's how to test the API using PowerShell instead of `curl`.

## Quick Test Script

Run the automated test script:
```powershell
.\test-api.ps1
```

This will test all major endpoints and show you the results.

## Manual Testing Commands

### 1. Register a User

```powershell
$body = @{
    email = "user@example.com"
    password = "Password123!"
    name = "Your Name"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body

# Save the token
$token = $response.token

# Display the result
$response | ConvertTo-Json -Depth 10
```

### 2. Login

```powershell
$loginBody = @{
    email = "user@example.com"
    password = "Password123!"
} | ConvertTo-Json

$loginResponse = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/login" `
    -Method Post `
    -ContentType "application/json" `
    -Body $loginBody

$token = $loginResponse.token
$loginResponse | ConvertTo-Json
```

### 3. Get Profile

```powershell
$headers = @{
    "Authorization" = "Bearer $token"
}

$profile = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/profile" `
    -Method Get `
    -Headers $headers

$profile | ConvertTo-Json
```

### 4. Get Thumbtack OAuth URL

```powershell
$authUrl = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/thumbtack/auth/url" `
    -Method Get `
    -Headers $headers

# Open the URL in your browser
Write-Host "Visit this URL to connect Thumbtack:"
Write-Host $authUrl.authUrl
Start-Process $authUrl.authUrl
```

### 5. Connect Thumbtack Account

After authorizing and getting the code from the callback URL:

```powershell
$connectBody = @{
    code = "YOUR_CODE_FROM_CALLBACK"
} | ConvertTo-Json

$connection = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/thumbtack/auth/connect" `
    -Method Post `
    -ContentType "application/json" `
    -Headers $headers `
    -Body $connectBody

$connection | ConvertTo-Json
```

### 6. Get All Leads (from all platforms)

```powershell
$leads = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/leads" `
    -Method Get `
    -Headers $headers

$leads | ConvertTo-Json -Depth 10
```

### 7. Get Leads from Thumbtack

```powershell
$thumbtackLeads = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/thumbtack/leads" `
    -Method Get `
    -Headers $headers

$thumbtackLeads | ConvertTo-Json -Depth 10
```

### 8. Send a Message to a Lead

```powershell
$messageBody = @{
    content = "Hi! Thanks for reaching out. I'd be happy to help with your project."
} | ConvertTo-Json

$message = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/leads/LEAD_ID_HERE/message" `
    -Method Post `
    -ContentType "application/json" `
    -Headers $headers `
    -Body $messageBody

$message | ConvertTo-Json
```

### 9. Send a Quote to a Lead

```powershell
$quoteBody = @{
    amount = 250.00
    description = "Complete bathroom cleaning service including deep clean of shower, toilet, and floors"
    validUntil = "2025-12-18T23:59:59Z"
} | ConvertTo-Json

$quote = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/leads/LEAD_ID_HERE/quote" `
    -Method Post `
    -ContentType "application/json" `
    -Headers $headers `
    -Body $quoteBody

$quote | ConvertTo-Json
```

### 10. Update Lead Status

```powershell
$statusBody = @{
    status = "contacted"
} | ConvertTo-Json

$updated = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/leads/LEAD_ID_HERE/status" `
    -Method Patch `
    -ContentType "application/json" `
    -Headers $headers `
    -Body $statusBody

$updated | ConvertTo-Json
```

### 11. Get Webhook Events

```powershell
$webhooks = Invoke-RestMethod -Uri "http://localhost:3000/api/webhooks/events" `
    -Method Get `
    -Headers $headers

$webhooks | ConvertTo-Json -Depth 10
```

## Tips

### Save Your Token for the Session

```powershell
# Save token to a variable
$token = "your-jwt-token-here"

# Create headers object for reuse
$headers = @{
    "Authorization" = "Bearer $token"
}

# Now you can use $headers in all subsequent requests
```

### Pretty Print JSON Responses

```powershell
$response | ConvertTo-Json -Depth 10 | Out-File response.json
code response.json  # Opens in VS Code
```

### Error Handling

```powershell
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/profile" `
        -Method Get `
        -Headers $headers

    Write-Host "Success!" -ForegroundColor Green
    $response | ConvertTo-Json

} catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red

    # Get detailed error response
    $errorDetails = $_.ErrorDetails.Message | ConvertFrom-Json
    $errorDetails | ConvertTo-Json
}
```

## Using Postman Instead

If you prefer a GUI tool:

1. **Import the API** into Postman
2. Set base URL: `http://localhost:3000`
3. Create environment variable: `token` = your JWT token
4. Use `{{token}}` in Authorization header: `Bearer {{token}}`

## Using curl in Git Bash

If you have Git Bash installed, you can use the standard `curl` commands from the documentation:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "Test123!", "name": "Test User"}'
```

---

**Quick Start**: Just run `.\test-api.ps1` to test all endpoints at once! 🚀
