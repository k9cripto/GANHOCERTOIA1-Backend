require('dotenv').config();

const express = require('express');
const axios = require('axios');
const moment = require('moment');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

const ODDS_API_KEY = "API AQUI";
const FOOTBALL_API_KEY = "API AQUI";
const ONESIGNAL_APP_ID = "API AQUI";
const ONESIGNAL_API_KEY = "API AQUI";
const JWT_SECRET = "API AQUI";
const MONGO_URI = "API AQUI";

mongoose.connect(MONGO_URI);

const User = mongoose.model('User', {
  user: String,
  pass: String
});

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.sendStatus(401);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.sendStatus(403);
  }
}

app.post('/register', async (req, res) => {
  const hash = await bcrypt.hash(req.body.pass, 10);
  const user = await User.create({ user: req.body.user, pass: hash });
  res.json(user);
});

app.post('/login', async (req, res) => {
  const user = await User.findOne({ user: req.body.user });
  if (!user) return res.sendStatus(401);
  const ok = await bcrypt.compare(req.body.pass, user.pass);
  if (!ok) return res.sendStatus(401);
  const token = jwt.sign({ id: user._id }, JWT_SECRET);
  res.json({ token });
});

async function getJogos() {
  const res = await axios.get(`https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}`);
  return res.data;
}

async function getTeamId(nome) {
  const res = await axios.get(`https://api-football-v1.p.rapidapi.com/v3/teams`, {
    params: { search: nome },
    headers: {
      'x-rapidapi-key': FOOTBALL_API_KEY,
      'x-rapidapi-host': 'api-football-v1.p.rapidapi.com'
    }
  });
  return res.data.response[0]?.team?.id;
}

async function getUltimosJogos(teamId) {
  const res = await axios.get(`https://api-football-v1.p.rapidapi.com/v3/fixtures`, {
    params: { team: teamId, last: 5 },
    headers: {
      'x-rapidapi-key': FOOTBALL_API_KEY,
      'x-rapidapi-host': 'api-football-v1.p.rapidapi.com'
    }
  });

  return res.data.response.map(j => {
    const isHome = j.teams.home.id == teamId;
    const gm = isHome ? j.goals.home : j.goals.away;
    const gs = isHome ? j.goals.away : j.goals.home;
    let r = "E";
    if (gm > gs) r = "V";
    else if (gm < gs) r = "D";
    return { golsMarcados: gm, golsSofridos: gs, resultado: r, xg: gm };
  });
}

function media(arr, campo) {
  return arr.reduce((s, j) => s + j[campo], 0) / arr.length;
}

function forma(jogos) {
  let pontos = 0;
  jogos.forEach(j => {
    if (j.resultado === "V") pontos += 3;
    else if (j.resultado === "E") pontos += 1;
  });
  return pontos / 15;
}

async function calcularProbabilidade(timeA, timeB) {
  const idA = await getTeamId(timeA);
  const idB = await getTeamId(timeB);

  const jogosA = await getUltimosJogos(idA);
  const jogosB = await getUltimosJogos(idB);

  const ataqueA = media(jogosA, "xg");
  const defesaA = media(jogosA, "golsSofridos");
  const formaA = forma(jogosA);

  const ataqueB = media(jogosB, "xg");
  const defesaB = media(jogosB, "golsSofridos");
  const formaB = forma(jogosB);

  let forcaA = (ataqueA * 0.4) + (defesaB * 0.3) + (formaA * 0.3);
  let forcaB = (ataqueB * 0.4) + (defesaA * 0.3) + (formaB * 0.3);

  forcaA *= 1.05;

  return forcaA / (forcaA + forcaB);
}

function valor(prob, odd) {
  return (prob * odd) - 1;
}

async function enviarNotificacao(msg) {
  await axios.post('https://onesignal.com/api/v1/notifications', {
    app_id: ONESIGNAL_APP_ID,
    included_segments: ["All"],
    contents: { en: msg }
  }, {
    headers: { Authorization: `Basic ${ONESIGNAL_API_KEY}` }
  });
}

cron.schedule('*/5 * * * *', async () => {
  const jogos = await getJogos();
  const agora = moment();

  for (let j of jogos) {
    const timeA = j.home_team;
    const timeB = j.away_team;
    const odd = j.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.price || 2;
    const diff = moment(j.commence_time).diff(agora, 'minutes');

    if (diff === 15) {
      const prob = await calcularProbabilidade(timeA, timeB);
      const ev = valor(prob, odd);

      if (ev > 0) {
        const msg = `⚽ ${timeA} x ${timeB}\n⏰ ${moment(j.commence_time).format("HH:mm")}\n📊 ${(prob * 100).toFixed(0)}%\n🔥 APOSTAR`;
        await enviarNotificacao(msg);
      }
    }
  }
});

app.get('/jogos', auth, async (req, res) => {
  const jogos = await getJogos();
  const lista = [];

  for (let j of jogos) {
    const prob = await calcularProbabilidade(j.home_team, j.away_team);
    const ev = valor(prob, j.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.price || 2);

    lista.push({
      timeCasa: j.home_team,
      timeVisitante: j.away_team,
      horario: moment(j.commence_time).format("HH:mm"),
      probabilidade: `${(prob * 100).toFixed(0)}%`,
      recomendacao: ev > 0 ? "APOSTAR" : "EVITAR"
    });
  }

  res.json(lista);
});

app.listen(3000);
