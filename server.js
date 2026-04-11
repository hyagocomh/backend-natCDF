require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  throw new Error('FRONTEND_URL não configurado');
}

const parsedFrontendUrl = new URL(FRONTEND_URL);
const corsAllowedOrigins = [
  parsedFrontendUrl.origin,
  ...(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
];

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Permite chamadas server-to-server sem header Origin (ex.: webhooks, curl).
    if (!origin) return callback(null, true);
    if (corsAllowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS bloqueado para esta origem.'));
  },
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-signature', 'x-request-id']
}));
app.use(express.json({ limit: '50kb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

const createPreferenceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false
});

const couponLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false
});

const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(globalLimiter);

/* ===============================
   MERCADO PAGO
================================ */
if (!process.env.MP_ACCESS_TOKEN) {
  throw new Error('MP_ACCESS_TOKEN não configurado');
}

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

const processedPayments = new Map();
const PROCESSED_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeString(value) {
  return String(value || '').trim();
}

function findCourseByName(courseName) {
  const sanitizedName = normalizeString(courseName);
  return Object.entries(CURSOS).find(([, curso]) => curso.nome === sanitizedName) || null;
}

function validateAluno(aluno) {
  if (!aluno || typeof aluno !== 'object') return 'Dados do aluno inválidos.';

  const nome = normalizeString(aluno.nome);
  const email = normalizeString(aluno.email).toLowerCase();
  const cpf = String(aluno.cpf || '').replace(/\D/g, '');
  const telefone = aluno.telefone ? String(aluno.telefone).replace(/\D/g, '') : null;

  if (nome.length < 3 || nome.length > 120) return 'Nome inválido.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Email inválido.';
  if (!/^\d{11}$/.test(cpf)) return 'CPF inválido.';
  if (telefone && (telefone.length < 10 || telefone.length > 13)) return 'Telefone inválido.';

  return { nome, email, cpf, telefone };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskCpf(cpfValue) {
  const digits = String(cpfValue || '').replace(/\D/g, '');
  if (digits.length !== 11) return 'Não informado';
  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

function parseMercadoPagoSignature(rawSignature) {
  const parsed = {};
  String(rawSignature || '')
    .split(',')
    .map((part) => part.trim())
    .forEach((part) => {
      const [key, value] = part.split('=');
      if (key && value) parsed[key] = value;
    });
  return parsed;
}

function getManifestFromWebhook(req) {
  const requestId = req.get('x-request-id');
  const { ts, v1 } = parseMercadoPagoSignature(req.get('x-signature'));
  const dataId = req.body?.data?.id;
  if (!requestId || !ts || !v1 || !dataId) return null;
  return `id:${dataId};request-id:${requestId};ts:${ts};`;
}

function isMercadoPagoWebhookValid(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  const manifest = getManifestFromWebhook(req);
  if (!manifest) return false;

  const hash = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  const { v1 } = parseMercadoPagoSignature(req.get('x-signature'));
  if (!v1) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'utf8'),
      Buffer.from(v1, 'utf8')
    );
  } catch {
    return false;
  }
}

function markPaymentProcessed(paymentId) {
  const now = Date.now();
  processedPayments.set(paymentId, now + PROCESSED_PAYMENT_TTL_MS);

  for (const [id, expiresAt] of processedPayments.entries()) {
    if (expiresAt <= now) processedPayments.delete(id);
  }
}

function wasPaymentProcessed(paymentId) {
  const expiresAt = processedPayments.get(paymentId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    processedPayments.delete(paymentId);
    return false;
  }
  return true;
}

/* ===============================
   VALIDAR CUPOM
================================ */
app.post('/validar-cupom', couponLimiter, (req, res) => {
  const { cupom, curso } = req.body || {};
  if (!cupom || !curso) {
    return res.status(400).json({ erro: 'Dados inválidos.' });
  }

  const foundCourse = findCourseByName(curso);
  if (!foundCourse) return res.status(400).json({ erro: 'Curso inválido.' });

  const [cursoId] = foundCourse;
  const codigo = normalizeString(cupom).toUpperCase();
  const cupomData = CUPONS[codigo];

  if (!cupomData || cupomData.cursoId !== cursoId) {
    return res.status(400).json({ erro: 'Cupom inválido.' });
  }

  return res.json({ valorComDesconto: cupomData.valorFinal });
});

/* ===============================
   CRIAR PREFERÊNCIA
================================ */
app.post('/create_preference', createPreferenceLimiter, async (req, res) => {
  try {
    const { curso, cupom, aluno } = req.body || {};
    const foundCourse = findCourseByName(curso);
    if (!foundCourse) {
      return res.status(400).json({ error: 'Curso inválido' });
    }

    const alunoValidado = validateAluno(aluno);
    if (typeof alunoValidado === 'string') {
      return res.status(400).json({ error: alunoValidado });
    }

    const [cursoId, courseData] = foundCourse;
    let valorFinal = courseData.valorBase;
    let cupomAplicado = null;

    if (cupom) {
      const codigo = normalizeString(cupom).toUpperCase();
      const cupomData = CUPONS[codigo];
      if (cupomData && cupomData.cursoId === cursoId) {
        valorFinal = cupomData.valorFinal;
        cupomAplicado = codigo;
      }
    }

    const result = await preference.create({
      body: {
        items: [{
          title: 'Curso NATUREZA CDF',
          description: courseData.nome,
          quantity: 1,
          unit_price: valorFinal,
          currency_id: 'BRL'
        }],
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
    console.error('ERRO CHECKOUT:', err?.message || err);
    return res.status(500).json({ error: 'Erro ao criar pagamento' });
  }
});

/* ===============================
   WEBHOOK MERCADO PAGO
================================ */
app.post('/webhook/mercadopago', webhookLimiter, async (req, res) => {
  try {
    const paymentId = req.body?.data?.id ? String(req.body.data.id) : null;
    if (!paymentId) return res.sendStatus(200);

    if (!isMercadoPagoWebhookValid(req)) {
      console.warn('Webhook Mercado Pago com assinatura inválida.');
      return res.sendStatus(401);
    }

    if (wasPaymentProcessed(paymentId)) {
      return res.sendStatus(200);
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }, timeout: 10000 }
    );

    const payment = response.data;
    if (payment.status !== 'approved') return res.sendStatus(200);

    markPaymentProcessed(paymentId);

    const meta = payment.metadata || {};
    const payerEmail = payment.payer?.email || meta.email || 'N/A';
    const payerCpf = payment.payer?.identification?.number || 'N/A';
    const nome = meta.nome || payment.payer?.first_name || 'N/A';

    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
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
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    console.log(`PAGAMENTO APROVADO | paymentId: ${paymentId}`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('ERRO WEBHOOK:', err?.response?.status || err?.message || err);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  if (!process.env.MP_WEBHOOK_SECRET) {
    console.warn('MP_WEBHOOK_SECRET não configurado. Assinatura do webhook não será validada.');
  }
  console.log(`Backend rodando na porta ${PORT}`);
});
