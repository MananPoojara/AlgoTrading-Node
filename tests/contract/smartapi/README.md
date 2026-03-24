# SmartAPI Test Suite

This folder contains test scripts to verify your SmartAPI connection and test various endpoints.

## Setup

1. **Copy the example env file:**

   ```bash
   cp test.env.example .env
   ```

2. **Edit `.env` with your credentials:**
   - Get your API Key from https://smartapi.angelone.in
   - Use your Angel One client code (login ID)
   - Use your Angel One password
   - **Important:** Get your TOTP Secret from the SmartAPI portal (NOT the 6-digit OTP)

   To find your TOTP Secret:
   1. Go to https://smartapi.angelone.in
   2. Login to your account
   3. Go to Profile/API Settings
   4. Look for "TOTP Secret" (a base32 string like `ABCD1234...`)

3. **Install dependencies:**
   ```bash
   npm install
   ```

## Running Tests

### Quick Test (All endpoints)

```bash
npm run all
```

### Individual Tests

**Test Login:**

```bash
npm run login
```

**Test Quote (Get market price):**

```bash
npm run quote
```

**Test Orders:**

```bash
npm run orders
```

**Test Positions:**

```bash
npm run positions
```

**Test Margin:**

```bash
npm run margin
```

**Test WebSocket (Real-time data):**

```bash
npm run websocket
```

## Troubleshooting

### "TOTP_SECRET not configured"

- You need to get the TOTP Secret from SmartAPI portal
- The TOTP Secret is NOT the 6-digit OTP code you enter daily
- It's a base32 string shown in your API settings

### "Invalid Credentials"

- Double-check your API Key
- Double-check your Client Code (login ID)
- Double-check your password

### "Token Expired"

- Your session may have expired
- Try logging in again

### WebSocket Connection Failed

- Make sure you're using the correct WebSocket URL
- Check your internet connection
- Some networks block WebSocket connections

## Test Results

The tests will show:

- ✅ Success (green)
- ❌ Failed (red)
- 📊 Data output

Example output:

```
==================================================
SmartAPI Integration Tests
==================================================

📱 Testing Login...
  Client Code: AACF344542
  API Key: c7eSf...
  TOTP Generated: 123456
  ✅ SUCCESS: Logged in successfully

👤 Testing Get Profile...
  ✅ SUCCESS
  User Name: TEST USER

💰 Testing Get RMS...
  ✅ SUCCESS
  Available Margin: 100000
```
