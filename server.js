require('dotenv').config();

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const axios = require('axios'); // ✅ axios no lugar de fetch
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
   CUPONS (APENAS PRESENCIAL)
================================ */
const CUPONS = {
  EX3NAT: { curso: 'MAX NATCDF (Combo Completo)', valorFinal: 360 },
  EX2NAT: { curso: 'NATCDF Combo 2 Matérias', valorFinal: 270 },
  EX1NAT: { curso: 'NATCDF 1 Matéria', valorFinal: 160 }
};

/* ===============================
   VALIDAR CUPOM (FRONTEND)
================================ */
app.post('/validar-cupom', (req, res) => {
  const { cupom, curso } = req.body;

  if (!cupom || !curso) {
    return res.status(400).json({ erro: 'Dados inválidos.' });
  }

  const codigo = cupom.toUpperCase().trim();
  const cupomData = CUPONS[codigo];

  if (!cupomData || !curso.includes(cupomData.curso)) {
    return res.status(400).json({ erro: 'Cupom inválido.' });
  }

  res.json({ valorComDesconto: cupomData.valorFinal });
});

/* ===============================
   CRIAR PREFERÊNCIA (CHECKOUT PRO)
================================ */
app.post('/create_preference', async (req, res) => {
  try {
    const { curso, cupom, aluno } = req.body;

    if (!curso || !aluno?.nome || !aluno?.cpf || !aluno?.email) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    /* ===============================
       PREÇO BASE
    ================================ */
    let valorFinal = null;

    if (curso.includes('NATUREZA CDF Online')) valorFinal = 799.90;
    else if (curso.includes('MAX NATCDF (Combo Completo)')) valorFinal = 450;
    else if (curso.includes('NATCDF Combo 2 Matérias')) valorFinal = 320;
    else if (curso.includes('NATCDF 1 Matéria')) valorFinal = 180;

    if (!valorFinal) {
      return res.status(400).json({ error: 'Curso inválido' });
    }

    /* ===============================
       APLICA CUPOM
    ================================ */
    if (cupom) {
      const codigo = cupom.toUpperCase().trim();
      const cupomData = CUPONS[codigo];
      if (cupomData && curso.includes(cupomData.curso)) {
        valorFinal = cupomData.valorFinal;
      }
    }

    console.log('✅ CHECKOUT FINAL:', { curso, cupom, valorFinal });

    const result = await preference.create({
      body: {
        items: [
          {
            title: 'Curso NATUREZA CDF',
            description: curso,
            quantity: 1,
            unit_price: valorFinal,
            currency_id: 'BRL'
          }
        ],

        metadata: {
          curso,
          valor: valorFinal,
          nome: aluno.nome,
          cpf: aluno.cpf,
          email: aluno.email
        },

        payer: {
          name: aluno.nome,
          email: aluno.email,
          identification: {
            type: 'CPF',
            number: String(aluno.cpf)
          }
        },

        back_urls: {
          success: `${process.env.FRONTEND_URL}/sucesso.html`,
          failure: `${process.env.FRONTEND_URL}/erro.html`,
          pending: `${process.env.FRONTEND_URL}/pendente.html`
        },

        auto_return: 'approved',

        // 🔥 webhook funcionando
        notification_url: 'https://backend-natcdf.onrender.com/webhook/mercadopago'
      }
    });

    res.json({ init_point: result.init_point });

  } catch (err) {
    console.error('❌ ERRO CHECKOUT MP');
    console.error(err?.response?.data || err);
    res.status(500).json({ error: 'Erro ao criar pagamento' });
  }
});

/* ===============================
   WEBHOOK MERCADO PAGO
================================ */
app.post('/webhook/mercadopago', async (req, res) => {
  console.log('📩 WEBHOOK RECEBIDO:', JSON.stringify(req.body, null, 2));

  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
        }
      }
    );

    const payment = response.data;

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
        <h2>Pagamento aprovado</h2>
        <p><strong>Curso:</strong> ${meta.curso}</p>
        <p><strong>Valor:</strong> R$ ${meta.valor}</p>
        <p><strong>Nome:</strong> ${meta.nome}</p>
        <p><strong>CPF:</strong> ${meta.cpf}</p>
        <p><strong>Email:</strong> ${meta.email}</p>
        <p><strong>ID Pagamento:</strong> ${payment.id}</p>
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
