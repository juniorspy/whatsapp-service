# Snapshot Before Normalization Changes

**Fecha:** 2025-11-06 13:57
**Propósito:** Guardar estado antes de modificar whatsapp-service para normalizar mensajes como web client

---

## Estado Actual

### Git Commit
```
Hash: a553ea0cb604ac2e044cd2fc793fc35b9e2ace75
Message: feat: support internal Docker URL to avoid hairpin NAT issue
Branch: main
```

### Backup Físico
```
Archivo: server.js.backup-20251106-135709
Ubicación: C:\Users\junio\StudioProjects\whatsapp-service\
Tamaño: 15KB
```

---

## Comportamiento Actual

### Webhook Evolution → Firebase

**Endpoint:** `POST /webhook/evolution`

**Payload Recibido de Evolution:**
```json
{
  "event": "messages.upsert",
  "instance": "colmado_colmado_william",
  "data": {
    "key": {
      "remoteJid": "18295616645@s.whatsapp.net",
      "fromMe": false,
      "id": "ACC2C902A2DBDFA30A1526E9BD9CA62C"
    },
    "message": {
      "conversation": "Hola"
    },
    "messageTimestamp": 1762450000,
    "pushName": "juniorspy16"
  }
}
```

**Payload Escrito a Firebase:**
```json
{
  "role": "user",
  "text": "Hola",
  "ts": 1762450000000,
  "pedidoId": null,
  "meta": {
    "chatId": "whatsapp:+18295616645",
    "slug": "colmado_william",
    "source": "whatsapp",
    "pushName": "juniorspy16",
    "remoteJid": "18295616645@s.whatsapp.net",
    "messageId": "ACC2C902A2DBDFA30A1526E9BD9CA62C",
    "firstInSession": true,
    "sessionStartTs": 1762450000000
  }
}
```

**Path Firebase:**
```
/mensajes/{slug}/{chatId}/{pushId}
```

**Problema:**
- `slug` se extrae del `instance` name (`colmado_colmado_william` → `colmado_william`)
- No se consulta Firebase para obtener datos reales de la tienda
- Falta `profileReady`
- `firstInSession` siempre es `true` (no verifica sesiones anteriores)
- No se garantiza que el `slug` extraído coincida con el slug real en Firebase

---

## Cambios Propuestos

### 1. Lookup de Tienda en Firebase

Antes de escribir mensaje, buscar tienda por `instanceName`:

```
/tiendas/{tiendaId}/evolution/instanceName === "colmado_colmado_william"
```

Extraer:
- `slug`
- `tiendaId`
- `telefono`

### 2. Enriquecer Payload

Agregar campos que faltan:
- `meta.slug` (desde Firebase, no desde instance name)
- `meta.profileReady: true`
- `meta.firstInSession` (verificar sesiones anteriores en `/mensajes/{slug}/{chatId}`)
- `meta.tiendaId` (opcional, pero útil)

### 3. Verificar Sesión Activa

Consultar últimos mensajes en `/mensajes/{slug}/{chatId}` para:
- Determinar si `firstInSession` debe ser `true` o `false`
- Calcular `sessionStartTs` correctamente
- Obtener `pedidoId` activo si existe

---

## Restauración

### Si algo sale mal:

**Opción 1: Revertir archivo**
```bash
cd C:\Users\junio\StudioProjects\whatsapp-service
cp server.js.backup-20251106-135709 server.js
git checkout server.js
```

**Opción 2: Revertir commit**
```bash
git reset --hard a553ea0cb604ac2e044cd2fc793fc35b9e2ace75
```

**Opción 3: Revertir en Dokploy**
- Ve a Dokploy → whatsapp-service → Deployments
- Haz click en deployment anterior (a553ea0)
- Redeploy

---

## Verificación Post-Cambio

### Test 1: Mensaje Simple
```
WhatsApp: "hola"
```
**Verificar:**
- ✓ Lookup de tienda funciona
- ✓ `slug` correcto en Firebase
- ✓ `profileReady: true`
- ✓ `firstInSession` correcto
- ✓ `pedidoId` se genera en Cloud Functions

### Test 2: Sesión Continuada
```
WhatsApp: "hola" → esperar respuesta → "quiero arroz"
```
**Verificar:**
- ✓ Primer mensaje: `firstInSession: true`
- ✓ Segundo mensaje: `firstInSession: false`
- ✓ `pedidoId` mantiene mismo valor
- ✓ `sessionStartTs` mantiene timestamp original

### Test 3: Múltiples Tiendas
```
Tienda A: "hola"
Tienda B: "hola"
```
**Verificar:**
- ✓ Cada tienda tiene su `slug` correcto
- ✓ No hay cross-contamination de datos
- ✓ Lookup funciona para ambas

---

**Estado:** Snapshot guardado, listo para modificaciones
