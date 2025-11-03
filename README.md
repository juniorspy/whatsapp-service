# whatsapp-service

Evolution API proxy for the Colmadero Android app.

This Node.js service creates Evolution instances, polls their connection status, and writes metadata into Firebase so the Android client can display WhatsApp QR codes and track connection state without hitting Evolution directly.
