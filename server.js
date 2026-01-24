require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ===============================
   MERCADO PAGO
================================ */
if (!process.env.MP_ACCESS_TOKEN) {
  throw new Error('❌ MP_ACCESS_TOKEN não configurado');
}

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const preference = new Preference(client);

/* ===============================
   CUPONS
================================ */
const CUPONS = {
  ALUNONAT3: { curso: 'MAX NATCDF (Combo Completo)', valorFinal: 360 },
  ALUNONAT2: { curso: 'NATCDF Combo 2 Matérias', valorFinal: 270 },
  ALUNONAT1: { curso: 'NATCDF 1 Matéria', valorFinal: 160 }
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

  if (!cupomData || !curso.includes(cupomData.curso)) {
    return res.status(400).json({ erro: 'Cupom inválido.' });
  }

  res.json({ valorComDesconto: cupomData.valorFinal });
});

/* ===============================
   CRIAR PREFERÊNCIA
================================ */
app.post('/create_preference', async (req, res) => {
  try {
    const { curso, cupom, aluno } = req.body;

    if (!curso || !aluno?.nome || !aluno?.cpf || !aluno?.email) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    let valorFinal = null;

    if (curso.includes('NATUREZA CDF Online')) valorFinal = 799.90;
    else if (curso.includes('MAX NATCDF (Combo Completo)')) valorFinal = 450;
    else if (curso.includes('NATCDF Combo 2 Matérias')) valorFinal = 320;
    else if (curso.includes('NATCDF 1 Matéria')) valorFinal = 180;

    if (valorFinal === null) {
      return res.status(400).json({ error: 'Curso inválido' });
    }

    if (cupom) {
      const codigo = cupom.toUpperCase().trim();
      const cupomData = CUPONS[codigo];
      if (cupomData && curso.includes(cupomData.curso)) {
        valorFinal = cupomData.valorFinal;
      }
    }

    const result = await preference.create({
      body: {
        items: [{
          title: 'Curso NATUREZA CDF',
          description: curso,
          quantity: 1,
          unit_price: valorFinal,
          currency_id: 'BRL'
        }],

        metadata: {
          curso,
          valor: valorFinal,
          nome: aluno.nome,
          cpf: aluno.cpf,
          email: aluno.email,
          cupom: cupom || null
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
        notification_url: 'https://backend-natcdf.onrender.com/webhook/mercadopago'
      }
    });

    res.json({ init_point: result.init_point });

  } catch (err) {
    console.error('❌ ERRO CHECKOUT:', err);
    res.status(500).json({ error: 'Erro ao criar pagamento' });
  }
});

/* ===============================
   WEBHOOK MERCADO PAGO
================================ */
app.post('/webhook/mercadopago', async (req, res) => {
  console.log('📩 WEBHOOK RECEBIDO');

  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
    );

    const payment = response.data;
    if (payment.status !== 'approved') return res.sendStatus(200);

    const meta = payment.metadata || {};

    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { name: 'NATUREZA CDF', email: process.env.EMAIL_FROM },
        to: [{ email: process.env.EMAIL_DESTINO }],
        subject: '🎉 Pagamento aprovado',
        htmlContent: `
          <h2>Pagamento aprovado</h2>
          <p><strong>Curso:</strong> ${meta.curso}</p>
          <p><strong>Valor:</strong> R$ ${meta.valor}</p>
          <p><strong>Nome:</strong> ${meta.nome}</p>
          <p><strong>CPF:</strong> ${meta.cpf}</p>
          <p><strong>Email:</strong> ${meta.email}</p>
          <p><strong>ID:</strong> ${payment.id}</p>
        `
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('📧 Email enviado com sucesso');
    res.sendStatus(200);

  } catch (err) {
    console.error('❌ ERRO WEBHOOK:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend rodando na porta ${PORT}`);
});
