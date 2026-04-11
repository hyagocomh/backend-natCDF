require('dotenv').config();

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { z } = require('zod');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';

const WEBHOOK_REPLAY_WINDOW_SECONDS = Number(process.env.WEBHOOK_REPLAY_WINDOW_SECONDS || 300);
const PROCESSED_PAYMENT_TTL_MS = Number(process.env.PROCESSED_PAYMENT_TTL_MS || 24 * 60 * 60 * 1000);
const PROCESSING_LOCK_TTL_MS = Number(process.env.PROCESSING_LOCK_TTL_MS || 2 * 60 * 1000);
const IDEMPOTENCY_DIR = path.join(__dirname, '.idempotency');

const REQUIRED_ENV_ALWAYS = ['FRONTEND_URL', 'MP_ACCESS_TOKEN'];
const REQUIRED_ENV_PROD = ['EMAIL_FROM', 'EMAIL_DESTINO', 'BREVO_API_KEY'];

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"log":"serialization_error"}';
  }
}

function maskEmail(emailValue) {
  const email = String(emailValue || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return 'n/a';
  const [name, domain] = email.split('@');
  if (!name || !domain) return 'n/a';
  const visible = name.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

function maskCpf(cpfValue) {
  const digits = String(cpfValue || '').replace(/\D/g, '');
  if (digits.length !== 11) return 'n/a';
  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

function redactValue(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey.includes('token') || normalizedKey.includes('secret') || normalizedKey.includes('authorization')) {
    return '[redacted]';
  }
  if (normalizedKey.includes('email')) return maskEmail(value);
  if (normalizedKey.includes('cpf')) return maskCpf(value);
  if (normalizedKey.includes('telefone') || normalizedKey.includes('phone')) return '[redacted_phone]';
  return value;
}

function redactObject(input) {
  if (Array.isArray(input)) return input.map((item) => redactObject(item));
  if (!input || typeof input !== 'object') return input;

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object') {
      out[key] = redactObject(value);
    } else {
      out[key] = redactValue(key, value);
    }
  }
  return out;
}

function logEvent(level, event, metadata = {}) {
  const payload = {
    level,
    event,
    ts: new Date().toISOString(),
    ...redactObject(metadata)
  };
  const line = safeJsonStringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function failStartupIfInvalidConfig() {
  const missing = REQUIRED_ENV_ALWAYS.filter((name) => !String(process.env[name] || '').trim());
  if (IS_PRODUCTION) {
    for (const name of REQUIRED_ENV_PROD) {
      if (!String(process.env[name] || '').trim()) missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Variaveis de ambiente obrigatorias ausentes: ${missing.join(', ')}`);
  }

  if (IS_PRODUCTION && !String(process.env.MP_WEBHOOK_SECRET || '').trim()) {
    console.warn(
      '{"level":"warn","event":"insecure_config_webhook_disabled","message":"MP_WEBHOOK_SECRET ausente em producao; endpoint /webhook/mercadopago respondera 503"}'
    );
  }

  if (!Number.isFinite(WEBHOOK_REPLAY_WINDOW_SECONDS) || WEBHOOK_REPLAY_WINDOW_SECONDS < 60 || WEBHOOK_REPLAY_WINDOW_SECONDS > 3600) {
    throw new Error('WEBHOOK_REPLAY_WINDOW_SECONDS invalido. Use valor entre 60 e 3600.');
  }

  if (!Number.isFinite(PROCESSED_PAYMENT_TTL_MS) || PROCESSED_PAYMENT_TTL_MS < 60 * 60 * 1000) {
    throw new Error('PROCESSED_PAYMENT_TTL_MS invalido. Use ao menos 3600000.');
  }

  if (!Number.isFinite(PROCESSING_LOCK_TTL_MS) || PROCESSING_LOCK_TTL_MS < 30 * 1000) {
    throw new Error('PROCESSING_LOCK_TTL_MS invalido. Use ao menos 30000.');
  }
}

failStartupIfInvalidConfig();

const FRONTEND_URL = process.env.FRONTEND_URL;
const parsedFrontendUrl = new URL(FRONTEND_URL);
const MP_WEBHOOK_SECRET = String(process.env.MP_WEBHOOK_SECRET || '');

function parseAllowedOrigins() {
  const origins = new Set([parsedFrontendUrl.origin]);

  for (const origin of String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    try {
      origins.add(new URL(origin).origin);
    } catch {
      throw new Error(`CORS_ORIGINS contem URL invalida: ${origin}`);
    }
  }

  if (IS_PRODUCTION) {
    for (const origin of origins) {
      const url = new URL(origin);
      const isLocalHost = ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !isLocalHost) {
        throw new Error(`Origem insegura em producao: ${origin}`);
      }
    }
  }

  return origins;
}

function parseTrustProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

const corsAllowedOrigins = parseAllowedOrigins();
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: IS_PRODUCTION
    ? {
        maxAge: 15552000,
        includeSubDomains: true,
        preload: false
      }
    : false
}));

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (corsAllowedOrigins.has(origin)) return callback(null, true);
      return callback(Object.assign(new Error('CORS bloqueado para esta origem.'), { statusCode: 403 }));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-signature', 'x-request-id'],
    optionsSuccessStatus: 204,
    maxAge: 600
  })
);

app.use(express.json({ limit: '20kb', strict: true, type: 'application/json' }));

function buildRateLimiter({ windowMs, max, name }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    handler(req, res) {
      logEvent('warn', 'rate_limit_blocked', {
        route: req.originalUrl,
        method: req.method,
        limiter: name,
        ip: req.ip
      });
      return res.status(429).json({ erro: 'Muitas requisicoes. Tente novamente em instantes.' });
    }
  });
}

const globalLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 300,
  name: 'global'
});
const createPreferenceLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  name: 'create_preference'
});
const couponLimiter = buildRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 80,
  name: 'validar_cupom'
});
const webhookLimiter = buildRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  name: 'webhook_mercadopago'
});
const confirmPaymentLimiter = buildRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 80,
  name: 'confirmar_pagamento'
});

app.use(globalLimiter);

/* ===============================
   MERCADO PAGO
================================ */
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});
const preference = new Preference(client);

const CURSOS = {
  NATCDF_ONLINE: { nome: 'NATUREZA CDF Online', valorBase: 799.9 },
  MAX_COMBO: { nome: 'MAX NATCDF (Combo Completo)', valorBase: 450 },
  COMBO_2: { nome: 'NATCDF Combo 2 Matérias', valorBase: 320 },
  MATERIA_1: { nome: 'NATCDF 1 Matéria', valorBase: 180 }
};

/* ===============================
   CUPONS
================================ */
const CUPONS = {
  ALUNO3: { cursoId: 'MAX_COMBO', valorFinal: 360 },
  ALUNO2: { cursoId: 'COMBO_2', valorFinal: 270 },
  ALUNO1: { cursoId: 'MATERIA_1', valorFinal: 160 }
};

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeCoupon(value) {
  return normalizeText(value).toUpperCase();
}

function findCourseByName(courseName) {
  const sanitizedName = normalizeText(courseName);
  return Object.entries(CURSOS).find(([, curso]) => curso.nome === sanitizedName) || null;
}

const validarCupomSchema = z
  .object({
    cupom: z.string().trim().min(1).max(32),
    curso: z.string().trim().min(1).max(140)
  })
  .strip();

const alunoSchema = z
  .object({
    nome: z.string().trim().min(3).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    cpf: z
      .string()
      .transform((value) => String(value || '').replace(/\D/g, ''))
      .refine((value) => /^\d{11}$/.test(value), { message: 'CPF invalido.' }),
    telefone: z
      .union([z.string().trim().max(20), z.null(), z.undefined()])
      .optional()
      .transform((value) => {
        const cleaned = String(value || '').replace(/\D/g, '');
        if (!cleaned) return null;
        return cleaned;
      })
      .refine((value) => value === null || (value.length >= 10 && value.length <= 13), {
        message: 'Telefone invalido.'
      })
  })
  .strip();

const createPreferenceSchema = z
  .object({
    curso: z.string().trim().min(1).max(140),
    cupom: z.union([z.string().trim().max(32), z.null(), z.undefined()]).optional(),
    aluno: alunoSchema
  })
  .strip();

const confirmarPagamentoSchema = z
  .object({
    paymentId: z.union([z.string().trim().max(40), z.number(), z.undefined(), z.null()]).optional(),
    payment_id: z.union([z.string().trim().max(40), z.number(), z.undefined(), z.null()]).optional(),
    collection_id: z.union([z.string().trim().max(40), z.number(), z.undefined(), z.null()]).optional()
  })
  .strip();

function parseBodyOrNull(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    logEvent('warn', 'request_validation_failed', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code
      }))
    });
    return null;
  }
  return result.data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function ensureIdempotencyDir() {
  await fsp.mkdir(IDEMPOTENCY_DIR, { recursive: true });
}

function sanitizePaymentId(paymentId) {
  const normalized = String(paymentId || '').trim();
  if (!/^\d{5,30}$/.test(normalized)) return null;
  return normalized;
}

function extractPaymentIdFromInput(input) {
  const payload = parseBodyOrNull(confirmarPagamentoSchema, input || {});
  if (!payload) return null;

  return (
    sanitizePaymentId(payload.paymentId) ||
    sanitizePaymentId(payload.payment_id) ||
    sanitizePaymentId(payload.collection_id) ||
    null
  );
}

function doneMarkerPath(paymentId) {
  return path.join(IDEMPOTENCY_DIR, `${paymentId}.done.json`);
}

function lockMarkerPath(paymentId) {
  return path.join(IDEMPOTENCY_DIR, `${paymentId}.lock`);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

async function isPaymentProcessed(paymentId) {
  const markerPath = doneMarkerPath(paymentId);
  const marker = await readJsonIfExists(markerPath);
  if (!marker || typeof marker.expiresAt !== 'number') return false;

  if (marker.expiresAt <= Date.now()) {
    await fsp.unlink(markerPath).catch(() => {});
    return false;
  }

  return true;
}

async function markPaymentProcessed(paymentId) {
  const markerPath = doneMarkerPath(paymentId);
  const tmpPath = `${markerPath}.tmp`;
  const data = {
    processedAt: Date.now(),
    expiresAt: Date.now() + PROCESSED_PAYMENT_TTL_MS
  };
  await fsp.writeFile(tmpPath, JSON.stringify(data), { encoding: 'utf8' });
  await fsp.rename(tmpPath, markerPath);
}

async function acquireProcessingLock(paymentId) {
  const lockPath = lockMarkerPath(paymentId);
  const lockContent = JSON.stringify({ createdAt: Date.now() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = await fsp.open(lockPath, 'wx');
      await fd.writeFile(lockContent, 'utf8');
      await fd.close();
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      try {
        const stat = await fsp.stat(lockPath);
        const isStale = Date.now() - stat.mtimeMs > PROCESSING_LOCK_TTL_MS;
        if (isStale) {
          await fsp.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      return false;
    }
  }

  return false;
}

async function releaseProcessingLock(paymentId) {
  await fsp.unlink(lockMarkerPath(paymentId)).catch(() => {});
}

async function pruneIdempotencyFiles() {
  const files = await fsp.readdir(IDEMPOTENCY_DIR).catch(() => []);
  const now = Date.now();

  await Promise.all(
    files.map(async (name) => {
      const fullPath = path.join(IDEMPOTENCY_DIR, name);
      if (name.endsWith('.lock')) {
        try {
          const stat = await fsp.stat(fullPath);
          if (now - stat.mtimeMs > PROCESSING_LOCK_TTL_MS) await fsp.unlink(fullPath);
        } catch {
          return;
        }
        return;
      }

      if (name.endsWith('.done.json')) {
        const content = await readJsonIfExists(fullPath);
        if (!content || typeof content.expiresAt !== 'number' || content.expiresAt <= now) {
          await fsp.unlink(fullPath).catch(() => {});
        }
      }
    })
  );
}

function parseMercadoPagoSignature(rawSignature) {
  if (typeof rawSignature !== 'string') return null;
  const sanitized = rawSignature.trim();
  if (!sanitized || sanitized.length > 512) return null;

  const parsed = {};
  const parts = sanitized.split(',').map((part) => part.trim());
  for (const part of parts) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index <= 0) return null;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key || !value) return null;

    if (key === 'ts') {
      if (!/^\d{10,13}$/.test(value)) return null;
      parsed.tsRaw = value;
      parsed.tsSeconds = value.length === 13 ? Math.floor(Number(value) / 1000) : Number(value);
    }

    if (key === 'v1') {
      if (!/^[a-f0-9]{64}$/i.test(value)) return null;
      parsed.v1 = value.toLowerCase();
    }
  }

  if (!parsed.tsRaw || !parsed.v1 || !Number.isFinite(parsed.tsSeconds)) return null;
  return parsed;
}

function safeCompareHex(expectedHex, providedHex) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHex) || !/^[a-f0-9]{64}$/i.test(providedHex)) return false;
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const provided = Buffer.from(providedHex, 'hex');
    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

function getWebhookManifest(req, signature) {
  const requestId = String(req.get('x-request-id') || '').trim();
  if (!requestId || requestId.length > 200 || !/^[A-Za-z0-9_.:\-]+$/.test(requestId)) return null;

  const paymentId = sanitizePaymentId(req.body?.data?.id);
  if (!paymentId) return null;

  return `id:${paymentId};request-id:${requestId};ts:${signature.tsRaw};`;
}

function isWebhookTimestampFresh(tsSeconds) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSeconds - tsSeconds);
  return age <= WEBHOOK_REPLAY_WINDOW_SECONDS;
}

function isMercadoPagoWebhookValid(req) {
  if (!MP_WEBHOOK_SECRET) return false;

  const signature = parseMercadoPagoSignature(req.get('x-signature'));
  if (!signature) return false;

  if (!isWebhookTimestampFresh(signature.tsSeconds)) {
    return false;
  }

  const manifest = getWebhookManifest(req, signature);
  if (!manifest) return false;

  const expectedHash = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  return safeCompareHex(expectedHash, signature.v1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryExternalError(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;

  const code = String(err?.code || '').toUpperCase();
  return ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}

async function requestWithRetry(executor, retries = 2) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      return await executor();
    } catch (err) {
      lastError = err;
      if (attempt >= retries || !shouldRetryExternalError(err)) break;
      const delayMs = 250 * 2 ** attempt;
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw lastError;
}

const mercadoPagoApi = axios.create({
  baseURL: 'https://api.mercadopago.com',
  timeout: 8000,
  headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
});

const brevoApi = axios.create({
  baseURL: 'https://api.brevo.com',
  timeout: 8000,
  headers: {
    'api-key': process.env.BREVO_API_KEY,
    'Content-Type': 'application/json'
  }
});

/* ===============================
   VALIDAR CUPOM
================================ */
app.post('/validar-cupom', couponLimiter, (req, res) => {
  const payload = parseBodyOrNull(validarCupomSchema, req.body || {});
  if (!payload) {
    return res.status(400).json({ erro: 'Dados inválidos.' });
  }

  const foundCourse = findCourseByName(payload.curso);
  if (!foundCourse) return res.status(400).json({ erro: 'Curso inválido.' });

  const [cursoId] = foundCourse;
  const codigo = normalizeCoupon(payload.cupom);
  const cupomData = CUPONS[codigo];

  if (!cupomData || cupomData.cursoId !== cursoId) {
    return res.status(400).json({ erro: 'Cupom inválido.' });
  }

  return res.json({ valorComDesconto: cupomData.valorFinal });
});

/* ===============================
   CRIAR PREFERENCIA
================================ */
app.post('/create_preference', createPreferenceLimiter, async (req, res) => {
  try {
    const payload = parseBodyOrNull(createPreferenceSchema, req.body || {});
    if (!payload) {
      return res.status(400).json({ error: 'Dados do aluno inválidos.' });
    }

    const foundCourse = findCourseByName(payload.curso);
    if (!foundCourse) {
      return res.status(400).json({ error: 'Curso inválido' });
    }

    const alunoValidado = {
      nome: normalizeText(payload.aluno.nome),
      email: normalizeText(payload.aluno.email).toLowerCase(),
      cpf: payload.aluno.cpf,
      telefone: payload.aluno.telefone
    };

    const [cursoId, courseData] = foundCourse;
    let valorFinal = courseData.valorBase;
    let cupomAplicado = null;

    if (payload.cupom) {
      const codigo = normalizeCoupon(payload.cupom);
      const cupomData = CUPONS[codigo];
      if (cupomData && cupomData.cursoId === cursoId) {
        valorFinal = cupomData.valorFinal;
        cupomAplicado = codigo;
      }
    }

    const result = await preference.create({
      body: {
        items: [
          {
            title: 'Curso NATUREZA CDF',
            description: courseData.nome,
            quantity: 1,
            unit_price: valorFinal,
            currency_id: 'BRL'
          }
        ],
        metadata: {
          cursoId,
          curso: courseData.nome,
          valor: valorFinal,
          nome: alunoValidado.nome,
          email: alunoValidado.email,
          telefone: alunoValidado.telefone,
          cupom: cupomAplicado
        },
        payer: {
          name: alunoValidado.nome,
          email: alunoValidado.email,
          identification: {
            type: 'CPF',
            number: alunoValidado.cpf
          }
        },
        back_urls: {
          success: `${parsedFrontendUrl.origin}/sucesso.html`,
          failure: `${parsedFrontendUrl.origin}/erro.html`,
          pending: `${parsedFrontendUrl.origin}/pendente.html`
        },
        auto_return: 'approved',
        notification_url: 'https://backend-natcdf.onrender.com/webhook/mercadopago'
      }
    });

    return res.json({ init_point: result.init_point });
  } catch (err) {
    logEvent('error', 'checkout_error', {
      message: err?.message || 'unknown_error',
      status: err?.status || err?.response?.status
    });
    return res.status(500).json({ error: 'Erro ao criar pagamento' });
  }
});

/* ===============================
   WEBHOOK MERCADO PAGO
================================ */
app.post('/webhook/mercadopago', webhookLimiter, async (req, res) => {
  if (!MP_WEBHOOK_SECRET) {
    logEvent('error', 'webhook_secret_missing_runtime', { env: NODE_ENV });
    return res.status(503).json({ error: 'Webhook desabilitado por configuracao insegura.' });
  }

  const paymentId = sanitizePaymentId(req.body?.data?.id);
  if (!paymentId) return res.sendStatus(200);

  if (!isMercadoPagoWebhookValid(req)) {
    logEvent('warn', 'webhook_invalid_signature', {
      paymentId,
      requestId: req.get('x-request-id') || null,
      ip: req.ip
    });
    return res.sendStatus(401);
  }

  try {
    if (await isPaymentProcessed(paymentId)) {
      return res.sendStatus(200);
    }

    const lockAcquired = await acquireProcessingLock(paymentId);
    if (!lockAcquired) {
      return res.sendStatus(200);
    }

    try {
      if (await isPaymentProcessed(paymentId)) {
        await releaseProcessingLock(paymentId);
        return res.sendStatus(200);
      }

      const response = await requestWithRetry(
        () => mercadoPagoApi.get(`/v1/payments/${encodeURIComponent(paymentId)}`),
        2
      );

      const payment = response.data;
      if (payment.status !== 'approved') {
        await releaseProcessingLock(paymentId);
        return res.sendStatus(200);
      }

      const meta = payment.metadata || {};
      const payerEmail = payment.payer?.email || meta.email || 'N/A';
      const payerCpf = payment.payer?.identification?.number || 'N/A';
      const nome = meta.nome || payment.payer?.first_name || 'N/A';

      await requestWithRetry(
        () =>
          brevoApi.post(
            '/v3/smtp/email',
            {
              sender: { name: 'NATUREZA CDF', email: process.env.EMAIL_FROM },
              to: [{ email: process.env.EMAIL_DESTINO }],
              subject: 'Matricula efetivada',
              htmlContent: `
                <h2>Matricula efetivada</h2>
                <p><strong>Curso:</strong> ${escapeHtml(meta.curso || 'N/A')}</p>
                <p><strong>Valor:</strong> R$ ${escapeHtml(meta.valor || 'N/A')}</p>
                <p><strong>Nome:</strong> ${escapeHtml(nome)}</p>
                <p><strong>CPF:</strong> ${escapeHtml(maskCpf(payerCpf))}</p>
                <p><strong>Email:</strong> ${escapeHtml(payerEmail)}</p>
                <p><strong>Telefone:</strong> ${escapeHtml(meta.telefone || 'Não informado')}</p>
                <p><strong>ID:</strong> ${escapeHtml(payment.id)}</p>
              `
            },
            { headers: { idempotencyKey: `mp-${paymentId}` } }
          ),
        1
      );

      await markPaymentProcessed(paymentId);
      await releaseProcessingLock(paymentId);

      logEvent('info', 'payment_approved', {
        paymentId,
        curso: meta.curso || 'N/A',
        valor: meta.valor || 'N/A',
        payerEmail
      });

      return res.sendStatus(200);
    } catch (err) {
      await releaseProcessingLock(paymentId);
      throw err;
    }
  } catch (err) {
    logEvent('error', 'webhook_error', {
      paymentId,
      message: err?.message || 'unknown_error',
      status: err?.response?.status || null
    });
    return res.sendStatus(500);
  }
});

/* ===============================
   CONFIRMAR PAGAMENTO (FALLBACK SEM WEBHOOK)
================================ */
async function handleConfirmarPagamento(req, res) {
  const paymentId = extractPaymentIdFromInput({
    ...(req.query || {}),
    ...(req.body || {})
  });

  if (!paymentId) {
    return res.status(400).json({ error: 'Pagamento invalido' });
  }

  try {
    const response = await requestWithRetry(
      () => mercadoPagoApi.get(`/v1/payments/${encodeURIComponent(paymentId)}`),
      2
    );

    const payment = response.data || {};
    const status = String(payment.status || 'unknown').toLowerCase();
    const aprovado = status === 'approved';

    logEvent('info', 'payment_confirmation_checked', {
      paymentId,
      status,
      aprovado
    });

    return res.json({ aprovado, status, paymentId: String(payment.id || paymentId) });
  } catch (err) {
    logEvent('error', 'payment_confirmation_error', {
      paymentId,
      message: err?.message || 'unknown_error',
      status: err?.response?.status || null
    });
    return res.status(502).json({ error: 'Erro ao confirmar pagamento' });
  }
}

app.get('/confirmar-pagamento', confirmPaymentLimiter, handleConfirmarPagamento);
app.post('/confirmar-pagamento', confirmPaymentLimiter, handleConfirmarPagamento);

app.use((err, req, res, next) => {
  const statusCode = Number(err?.statusCode || err?.status || 500);
  if (statusCode === 403 && String(err?.message || '').includes('CORS bloqueado')) {
    return res.status(403).json({ erro: 'CORS bloqueado para esta origem.' });
  }

  logEvent('error', 'unhandled_error', {
    route: req?.originalUrl,
    method: req?.method,
    message: err?.message || 'internal_error'
  });

  return res.status(500).json({ error: 'Erro interno' });
});

(async () => {
  await ensureIdempotencyDir();
  await pruneIdempotencyFiles();

  setInterval(() => {
    pruneIdempotencyFiles().catch((err) => {
      logEvent('warn', 'idempotency_prune_failed', { message: err?.message || 'unknown_error' });
    });
  }, 30 * 60 * 1000).unref();

  app.listen(PORT, () => {
    logEvent('info', 'server_started', {
      port: PORT,
      env: NODE_ENV,
      corsOrigins: Array.from(corsAllowedOrigins)
    });
  });
})().catch((err) => {
  logEvent('error', 'startup_failed', { message: err?.message || 'unknown_error' });
  process.exit(1);
});
