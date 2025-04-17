const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// ✅ Sert index.html à l'accueil /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

let threadId = null;
let previousUserMessage = null;

// Ici ton code actuel pour /chat
app.post('/chat', async (req, res) => {
  // ➔ tout ton code de chatbot ici
  res.json({ reply: "Bot opérationnel !" }); // Version test simple
});

app.listen(PORT, () => {
  console.log(`✅ Serveur actif sur le port ${PORT}`);
});
