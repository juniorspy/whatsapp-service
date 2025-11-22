# WhatsApp Service - Deployment Guide

## Changes Made to Fix QR Timeout Issue

### Problem
- Android app timeout (15s) + Backend timeout (15-20s) < Evolution API response time
- Evolution was generating QRs but response never reached Android client
- Result: QR codes visible in Evolution logs but not displayed in app

### Solution Implemented

**1. Backend Changes (`src/config/env.js`, `src/controllers/whatsappController.js`)**
- Increased Evolution API timeout: 15s → 45s
- Added fallback QR fetch: if QR not in create response, fetch separately
- Better error handling when QR not immediately available
- Improved logging to track QR availability

**2. Android Changes (`ConnectWhatsAppActivity.java`)**
- Increased read timeout: 15s → 50s (for both POST and GET requests)
- Improved QR handling: immediately poll if QR not in initial response
- Better null checking for QR data

**3. Configuration Updates**
- `.env`: `EVOLUTION_API_TIMEOUT=45000`
- `.env.example`: Updated default timeout

## Deployment Steps

### 1. Update Environment Variables in Dokploy

Navigate to your Dokploy instance at https://neo.onrpa.com and update the `whatsapp-service` app:

**Environment Variables to Update:**
```bash
EVOLUTION_API_TIMEOUT=45000
```

Verify all other variables are present:
```bash
PORT=4001
LOG_LEVEL=info
API_TOKEN=colmadero-whatsapp-admin
EVOLUTION_API_URL=https://evo.onrpa.com
EVOLUTION_MASTER_KEY=<your-key>
FIREBASE_SERVICE_ACCOUNT=./credentials/service-account.json
FIREBASE_DATABASE_URL=https://neocolmado-fc4b8-default-rtdb.firebaseio.com
```

### 2. Redeploy Backend

**Option A: Via Dokploy UI**
1. Go to https://neo.onrpa.com
2. Navigate to `whatsapp-service` app
3. Click "Redeploy" or "Restart"
4. Monitor logs for successful startup

**Option B: Via Git Push**
```bash
cd C:\Users\junio\StudioProjects\conecta2\backend\whatsapp-service
git add .
git commit -m "fix: increase timeouts and improve QR handling"
git push
# Dokploy will auto-deploy if webhook is configured
```

### 3. Verify Backend Deployment

**Check health endpoint:**
```bash
curl https://whatsapp-service.onrpa.com/health
# Should return: {"status":"ok","timestamp":"..."}
```

**Test connect endpoint (with your credentials):**
```bash
curl -X POST https://whatsapp-service.onrpa.com/api/v1/whatsapp/connect-whatsapp-colmado \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer colmadero-whatsapp-admin" \
  -d '{
    "tiendaId": "test_tienda",
    "slug": "test_colmado",
    "telefono": "8091234567",
    "webhookUrl": "https://automations.onrpa.com/webhook/test"
  }'
```

Expected response (within 45s):
```json
{
  "success": true,
  "status": "pending",
  "instanceName": "colmado_test_colmado",
  "qrCode": "data:image/png;base64,...",
  "apiKey": "...",
  "created": true
}
```

### 4. Build and Deploy Android APK

**Build debug APK:**
```bash
cd C:\Users\junio\StudioProjects\conecta2
./gradlew assembleDebug
```

**Build release APK:**
```bash
./gradlew assembleRelease
```

**Install on device:**
```bash
./gradlew installDebug
# or
adb install app/build/outputs/apk/debug/app-debug.apk
```

### 5. Test End-to-End Flow

1. Open Colmadero app
2. Go to Ajustes → "Conectar WhatsApp"
3. Click "Conectar WhatsApp" button
4. Wait 10-45 seconds (progress spinner should show)
5. QR code should appear
6. Scan with WhatsApp
7. Status should update to "Conectado"

**Monitor logs during test:**
- Backend: Check Dokploy logs for `whatsapp-service`
- Evolution: Check Evolution API logs for QR generation
- Android: Check logcat with tag `ConnectWhatsApp`

## Rollback Plan

If issues occur:

**1. Backend Rollback:**
```bash
# In Dokploy, redeploy previous version
# Or revert changes:
cd C:\Users\junio\StudioProjects\conecta2\backend\whatsapp-service
git revert HEAD
git push
```

**2. Android Rollback:**
```bash
# Reinstall previous APK version
adb install path/to/previous-version.apk
```

## Monitoring

**Key metrics to watch:**
- Backend response time: Should be 10-45s for `/connect-whatsapp-colmado`
- Evolution QR generation: Check logs for `qrcodeCount` incrementing
- Android timeout errors: Should no longer occur
- Success rate: Monitor Firebase for successful connections

**Log patterns to look for:**

Backend success:
```
Evolution instance created and stored in Firebase
{ tiendaId: "...", instanceName: "...", hasQr: true }
```

Backend fallback (still working):
```
QR not in create response, fetching separately
Failed to fetch QR immediately after creation, will be available via polling
```

## Troubleshooting

**Issue: Still getting timeout**
- Check Evolution API is responding: `curl https://evo.onrpa.com/health`
- Verify timeout values in Dokploy environment
- Check network latency between backend and Evolution

**Issue: QR generated but not displayed**
- Check Android logs for Base64 decode errors
- Verify QR format in backend response (should have `data:image/png;base64,` prefix)
- Test with manual status poll: `/status?tiendaId=xxx&includeQr=true`

**Issue: Connection succeeds but no webhooks**
- Verify n8n webhook URL is correct
- Check Evolution webhook configuration in logs
- Test webhook manually with curl

## Related Documentation

- Main plan: `documentation/WHATSAPP_INTEGRATION_PLAN.md`
- Progress tracking: `documentation/WHATSAPP_INTEGRATION_PROGRESS.md`
- Evolution API docs: `evo-api/README_EVOLUTION_API.md`

---

**Last Updated:** 2025-11-04
**Version:** 0.2.0 (timeout fix)
