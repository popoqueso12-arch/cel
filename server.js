// Celsia Internet API v3.0 — 2captcha reCAPTCHA Enterprise solver (sin browser)
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const CAPTCHA_KEY       = '32d82491b8a3a2a5e53ab12e09501da9';
const RECAPTCHA_SITEKEY = '6Ldw7rQtAAAAALe6xrJrBp0rRPxhnzSv5c8w8pPd';

const PORT      = process.env.PORT      || 3001;
const TG_TOKEN  = process.env.TG_TOKEN  || '';
const TG_CHAT   = process.env.TG_CHAT   || '';

const PORTAL   = 'https://app.celsiainternet.com/components/payments';
const API_BASE = `${PORTAL}/api`;
const AUTH_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzYWx0IjoiNTYxNDE2IiwiaWQiOiIyNWQ3YmYyYS03MzY0LTQyNzctOTZhYS1jMWYyZWZjYTc2ZmEiLCJhcHAiOiJQUkRBUFAiLCJuYW1lIjoiUFJEQVBQIiwidXNlcm5hbWUiOiJQUkRBUFAiLCJkZXZpY2UiOiJhcGlyZXN0IiwiZHVyYXRpb24iOjAsInByb2plY3RJZCI6IiIsInByb2ZpbGVUcCI6IiIsInRhZyI6IiJ9.-a7hw67SECclmXkMdWh4g9dDEaMbmHGuIyPS5pL8pyo';

function apiHeaders() {
  return {
    'Content-Type':  'application/json',
    'X-Timestamp':   new Date().toISOString(),
    'X-Origin':      'https://app.celsiainternet.com',
    'Authorization': `Bearer ${AUTH_JWT}`,
  };
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: true, credentials: true }));

// ── Cache 10 min ──────────────────────────────────────────────────────────────
const _cache = new Map();
const TTL    = 10 * 60 * 1000;
function cacheGet(k) {
  const h = _cache.get(k);
  if (h && Date.now() - h.ts < TTL) return h.v;
  _cache.delete(k); return null;
}
function cacheSet(k, v) { _cache.set(k, { v, ts: Date.now() }); }

// ── Rate limit 15 req/min por IP ──────────────────────────────────────────────
const _rl = new Map();
function allowed(ip, max = 15, win = 60_000) {
  const now  = Date.now();
  const list = (_rl.get(ip) || []).filter(t => now - t < win);
  if (list.length >= max) return false;
  list.push(now); _rl.set(ip, list); return true;
}
function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// ── 2captcha: resolver reCAPTCHA Enterprise y buscar directamente vía HTTP ────
async function celsiaBuscar(numero, tipo = 'document') {
  // 1. Crear tarea en 2captcha
  console.log(`  [2captcha] Enviando tarea reCAPTCHA Enterprise...`);
  const createRes = await axios.post('https://api.2captcha.com/createTask', {
    clientKey: CAPTCHA_KEY,
    task: {
      type: 'RecaptchaV2EnterpriseTaskProxyless',
      websiteURL: `${PORTAL}/`,
      websiteKey: RECAPTCHA_SITEKEY,
    },
  }, { timeout: 15_000 });

  if (createRes.data.errorId !== 0) {
    throw new Error(`2captcha createTask: ${createRes.data.errorDescription}`);
  }

  const taskId = createRes.data.taskId;
  console.log(`  [2captcha] Tarea creada id=${taskId}, esperando resolución...`);

  // 2. Polling cada 3s hasta obtener el token (máx 90s → 30 intentos)
  let token = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await axios.post('https://api.2captcha.com/getTaskResult', {
      clientKey: CAPTCHA_KEY,
      taskId,
    }, { timeout: 10_000 });

    if (pollRes.data.status === 'ready') {
      token = pollRes.data.solution.gRecaptchaResponse;
      console.log(`  [2captcha] ✅ Token obtenido en ${(i + 1) * 3}s`);
      break;
    }
    if (pollRes.data.errorId !== 0) {
      throw new Error(`2captcha getTaskResult: ${pollRes.data.errorDescription}`);
    }
  }

  if (!token) throw new Error('2captcha: timeout esperando el token reCAPTCHA');

  // 3. Llamar directamente a Celsia con el token válido
  console.log(`  [Celsia] Buscando ${tipo}: ${numero}...`);
  const { data } = await axios.post(
    `${API_BASE}/payments/invoice/search`,
    { number: numero, option: tipo, token },
    { headers: apiHeaders(), timeout: 15_000 }
  );

  return data;
}

// ── Axios: facturas por cuenta (sin Turnstile) ────────────────────────────────
async function getFacturas(cuenta) {
  const { data } = await axios.post(
    `${API_BASE}/invoices/ackParsed`,
    { iporigen: '1', idcliente: 1, usuario: 'celsia', contraseña: 'CuentaCelsia.202412#', cuenta },
    { headers: apiHeaders(), timeout: 15_000 }
  );
  return data;
}

// ── Axios: URL del PDF de factura ─────────────────────────────────────────────
async function getFacturaUrl(key, cuenta, periodo) {
  const { data } = await axios.post(
    `${API_BASE}/invoices/ack/invoice`,
    { key, account: cuenta, period: periodo },
    { headers: apiHeaders(), timeout: 15_000 }
  );
  return data;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgText(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
  }).catch(() => {});
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_, res) =>
  res.json({ ok: true, uptime: Math.floor(process.uptime()), cache: _cache.size })
);

// Buscar por cédula o número de cuenta
app.post('/api/celsia/buscar', async (req, res) => {
  if (!allowed(getIp(req)))
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un momento.' });

  const { numero, tipo = 'document' } = req.body || {};
  if (!numero)
    return res.status(400).json({ error: 'El número es requerido.' });

  const numClean  = String(numero).trim();
  const cacheKey  = `buscar_${tipo}_${numClean}`;
  const cached    = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, _cached: true });

  try {
    console.log(`\n[Celsia] Búsqueda ${tipo}: ${numClean}`);

    const result = await celsiaBuscar(numClean, tipo);

    if (!result)
      return res.status(502).json({ error: 'Sin respuesta del portal Celsia. Intenta de nuevo.' });

    if (!result.ok)
      return res.status(404).json({ error: result.message || 'No se encontraron cuentas.' });

    await tgText(
      `🌐 <b>Celsia Internet — Consulta</b>\n\n` +
      `🔍 <b>Tipo:</b> ${tipo === 'document' ? 'Documento' : 'Cuenta'}\n` +
      `📝 <b>Número:</b> <code>${numClean}</code>\n` +
      `📊 <b>Resultados:</b> ${result.result?.length ?? 0}\n` +
      `🕐 <b>Hora:</b> ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
    );

    cacheSet(cacheKey, result);
    return res.json(result);

  } catch (err) {
    console.error('[Celsia] Error buscar:', err.message);
    return res.status(502).json({ error: 'Error al consultar Celsia. Intenta de nuevo.' });
  }
});

// Obtener facturas pendientes de una cuenta
app.post('/api/celsia/facturas', async (req, res) => {
  const { cuenta } = req.body || {};
  if (!cuenta)
    return res.status(400).json({ error: 'El número de cuenta es requerido.' });

  const cacheKey = `facturas_${cuenta}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, _cached: true });

  try {
    console.log(`[Celsia] Facturas cuenta: ${cuenta}`);
    const data = await getFacturas(cuenta);
    cacheSet(cacheKey, data);
    return res.json(data);
  } catch (err) {
    console.error('[Celsia] Error facturas:', err.message);
    return res.status(502).json({ error: 'No se pudieron obtener las facturas.' });
  }
});

// Obtener URL del PDF de una factura
app.post('/api/celsia/factura-url', async (req, res) => {
  const { key, cuenta, periodo } = req.body || {};
  if (!key || !cuenta)
    return res.status(400).json({ error: 'Faltan parámetros (key, cuenta).' });

  try {
    const data = await getFacturaUrl(key, cuenta, periodo);
    return res.json(data);
  } catch (err) {
    console.error('[Celsia] Error factura-url:', err.message);
    return res.status(502).json({ error: 'No se pudo obtener el PDF.' });
  }
});

app.use(express.static(path.join(__dirname)));

app.listen(PORT, () =>
  console.log(`\n✅ Celsia API v3.0 corriendo en http://localhost:${PORT}\n   Portal: http://localhost:${PORT}/factura.html\n`)
);
