require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ===============================
   MERCADO PAGO
================================ */
if (!process.env.MP_ACCESS_TOKEN) {
  throw new Error('❌ MP_ACCESS_TOKEN não configurado no .env');
}

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const preference = new Preference(client);

/* ===============================
   CUPONS
================================ */
const CUPONS = {
  EX3NAT: { curso: 'MAX NATCDF (Combo Completo)', valorFinal: 360 },
  EX2NAT: { curso: 'NATCDF Combo 2 Matérias', valorFinal: 270 },
  EX1NAT: { curso: 'NATCDF 1 Matéria', valorFinal: 160 }
};

/* ===============================
   VALIDAR CUPOM
================================ */
app.post('/validar-cupom', (req, res) => {
  const { cupom, curso } = req.body;

  if (!cupom || !curso) {
    return res.status(400).json({ erro: 'Dados inválidos.' });
  }

  const codigo = cupom.toUpperCase().trim();
  const cupomData = CUPONS[codigo];

  if (!cupomData || !curso.startsWith(cupomData.curso)) {
    return res.status(400).json({ erro: 'Cupom inválido.' });
  }

  res.json({ valorComDesconto: cupomData.valorFinal });
});

/* ===============================
   CRIAR PREFERÊNCIA (CHECKOUT PRO)
================================ */
app.post('/create_preference', async (req, res) => {
  try {
    const { curso } = req.body;

    if (!curso) {
      return res.status(400).json({ error: 'Curso não informado' });
    }

    /* ===============================
       TABELA DE PREÇOS (BACKEND)
    ================================ */
    const PRECOS = {
      'NATUREZA CDF Online': 799.90,
      'MAX NATCDF (Combo Completo)': 450,
      'NATCDF Combo 2 Matérias': 320,
      'NATCDF 1 Matéria': 180
    };

    // Remove matérias extras do nome (caso presencial)
    const cursoBase = Object.keys(PRECOS).find(c =>
      curso.startsWith(c)
    );

    if (!cursoBase) {
      return res.status(400).json({ error: 'Curso inválido' });
    }

    const valorFinal = PRECOS[cursoBase];

    const result = await preference.create({
      body: {
        items: [
          {
            title: 'Curso NATUREZA CDF',
            description: curso,
            quantity: 1,
            unit_price: valorFinal, // ✅ VALOR CORRETO
            currency_id: 'BRL'
          }
        ],

        back_urls: {
          success: `${process.env.FRONTEND_URL}/sucesso.html`,
          failure: `${process.env.FRONTEND_URL}/erro.html`,
          pending: `${process.env.FRONTEND_URL}/pendente.html`
        },

        auto_return: 'approved',
        notification_url: `${process.env.RENDER_URL}/webhook/mercadopago`
      }
    });

    res.json({ init_point: result.init_point });

  } catch (err) {
    console.error('❌ ERRO CHECKOUT MP');
    console.error(err?.response?.data || err);

    res.status(500).json({
      error: 'Erro ao criar pagamento'
    });
  }
});



/* ===============================
   WEBHOOK MERCADO PAGO
================================ */
app.post('/create_preference', async (req, res) => {
  try {
    const { curso, valor } = req.body;

    if (!curso || !valor) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const result = await preference.create({
      body: {
        items: [
          {
            title: 'Curso NATUREZA CDF',
            description: curso,
            quantity: 1,
            unit_price: Number(valor), // ✅ VALOR REAL DO CURSO
            currency_id: 'BRL'
          }
        ],
        back_urls: {
          success: `${process.env.FRONTEND_URL}/sucesso.html`,
          failure: `${process.env.FRONTEND_URL}/erro.html`,
          pending: `${process.env.FRONTEND_URL}/pendente.html`
        },
        auto_return: 'approved',
        notification_url: `${process.env.RENDER_URL}/webhook/mercadopago`
      }
    });

    res.json({
      init_point: result.init_point
    });

  } catch (err) {
    console.error('❌ ERRO CHECKOUT MP');
    console.error(err?.response?.data || err);

    res.status(500).json({
      error: 'Erro ao criar pagamento'
    });
  }
});


/* ===============================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log(`🚀 Backend rodando na porta ${PORT}`);
});
