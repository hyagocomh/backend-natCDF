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
       TABELA DE PREÇOS (SEGURA)
    ================================ */
    let valorFinal = null;

    if (curso.includes('NATUREZA CDF Online')) {
      valorFinal = 799.90;
    }

    else if (curso.includes('MAX NATCDF (Combo Completo)')) {
      valorFinal = 450;
    }

    else if (curso.includes('NATCDF Combo 2 Matérias')) {
      valorFinal = 320;
    }

    else if (curso.includes('NATCDF 1 Matéria')) {
      valorFinal = 180;
    }

    if (!valorFinal) {
      console.error('❌ CURSO NÃO MAPEADO:', curso);
      return res.status(400).json({ error: 'Curso inválido' });
    }

    console.log('✅ Criando pagamento:', {
      curso,
      valorFinal
    });

    const result = await preference.create({
      body: {
        items: [
          {
            title: 'Curso NATUREZA CDF',
            description: curso,
            quantity: 1,
            unit_price: valorFinal, // ✅ SEMPRE VÁLIDO
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
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = await response.json();

    if (payment.status !== 'approved') {
      return res.sendStatus(200);
    }

    const meta = payment.metadata || {};

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: `"NATUREZA CDF" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_DESTINO,
      subject: '🎉 Pagamento aprovado',
      html: `
        <p><strong>Nome:</strong> ${meta.nome}</p>
        <p><strong>CPF:</strong> ${meta.cpf}</p>
        <p><strong>Email:</strong> ${meta.email}</p>
        <p><strong>Curso:</strong> ${meta.curso}</p>
        <p><strong>Valor:</strong> R$ ${meta.valor}</p>
      `
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ ERRO WEBHOOK:', err);
    res.sendStatus(500);
  }
});

/* ===============================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log(`🚀 Backend rodando na porta ${PORT}`);
});
