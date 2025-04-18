// server.js complet corrige et adapte pour toi Corinne !

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
app.use(express.static('.'));

// Sert ton index.html a la racine
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

let threadId = null;
let previousUserMessage = null;

// Detecter si la reponse est trop vague
function needExtraSearch(text) {
  const patterns = [
    /consulter/i,
    /vérifier/i,
    /plateformes?/i,
    /TripAdvisor/i,
    /Yelp/i,
    /je vous recommande de chercher/i,
    /vous pouvez rechercher/i,
    /plus d'informations en ligne/i,
    /adresse/i,
    /téléphone/i,
    /numéro/i,
    /coordonnées/i,
    /horaires/i
  ];
  return patterns.some(pattern => pattern.test(text));
}

// Reformuler intelligemment la recherche avant Google
function reformulateQuery(previousUserMessage, userMessage) {
  const context = "proximite appartement 16 rue du Moulin a Coupvray";
  const last = previousUserMessage?.toLowerCase() || "";
  const current = userMessage?.toLowerCase() || "";

  if (current.includes("adresse") || current.includes("adresses")) {
    if (last.includes("restaurant") || last.includes("restaurants")) {
      return `${context} adresses des restaurants autour`;
    } else if (last.includes("commerces") || last.includes("magasins")) {
      return `${context} adresses des commerces alentours`;
    } else {
      return `${context} adresses autour`;
    }
  }

  return `${context} ${last} ${current}`;
}

// Fonction recherche Google via Serper
async function searchGoogle(query) {
  try {
    const response = await axios.post(
      'https://google.serper.dev/search',
      { q: query },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const result = response.data.organic?.[0];
    if (result) {
      const title = result.title || '';
      const snippet = result.snippet || '';
      const link = result.link || '';

      return `🔎 **${title}**\n${snippet}\n👉 [Voir en ligne](${link})`;
    } else {
      return "Je n’ai pas trouvé de résultats pertinents.";
    }
  } catch (err) {
    console.error('Erreur Serper:', err.response ? err.response.data : err.message);
    return "Erreur lors de la recherche sur Internet.";
  }
}

// Route principale chatbot
app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;

  try {
    if (["oui", "vas-y", "ok", "d'accord", "allez-y"].includes(userMessage.toLowerCase().trim())) {
      const result = await searchGoogle(previousUserMessage || 'informations Coupvray');
      return res.json({ reply: result });
    }

    // Preparation du thread OpenAI
    async function ensureThreadReady() {
      try {
        if (threadId) {
          const runsRes = await axios.get(
            `https://api.openai.com/v1/threads/${threadId}/runs`,
            {
              headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'assistants=v2'
              }
            }
          );
          const activeRun = runsRes.data.data.find(run => run.status === 'in_progress' || run.status === 'queued');

          if (activeRun) {
            console.log('⚡ Run actif detecte ➔ Creation d\'un nouveau thread');
            threadId = null;
          }
        }

        if (!threadId) {
          const threadRes = await axios.post(
            'https://api.openai.com/v1/threads',
            {},
            {
              headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'assistants=v2',
                'Content-Type': 'application/json'
              }
            }
          );
          threadId = threadRes.data.id;
          console.log('🧵 Nouveau thread cree :', threadId);
        }

      } catch (err) {
        console.error('Erreur ensureThreadReady:', err.response?.data || err.message);
        throw new Error("Impossible de creer ou recuperer un thread.");
      }
    }

    await ensureThreadReady();

    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      { role: 'user', content: userMessage },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json'
        }
      }
    );

    const runRes = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      { assistant_id: ASSISTANT_ID },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
          'Content-Type': 'application/json'
        }
      }
    );

    const runId = runRes.data.id;
    let runStatus = 'in_progress';
    let toolCalls = [];

    while (runStatus === 'in_progress') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusRes = await axios.get(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
      runStatus = statusRes.data.status;
      toolCalls = statusRes.data.required_action?.submit_tool_outputs?.tool_calls || [];
    }

    if (toolCalls.length > 0) {
      const toolOutputs = await Promise.all(toolCalls.map(async (toolCall) => {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        if (toolName === 'search_google') {
          const searchQuery = reformulateQuery(previousUserMessage, userMessage);
          const result = await searchGoogle(searchQuery);
          return { tool_call_id: toolCall.id, output: result };
        }
        return null;
      }));

      const filteredOutputs = toolOutputs.filter(Boolean);

      if (filteredOutputs.length > 0) {
        await axios.post(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runId}/submit_tool_outputs`,
          { tool_outputs: filteredOutputs },
          {
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'OpenAI-Beta': 'assistants=v2',
              'Content-Type': 'application/json'
            }
          }
        );
      }
    }

    const messagesRes = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    const messages = messagesRes.data.data;
    const lastMessage = messages.find(m => m.role === 'assistant');

    if (lastMessage && lastMessage.content && lastMessage.content.length > 0) {
      let reply = lastMessage.content[0].text.value;
      reply = reply.replace(/【.*?†.*?】/g, '').trim();

      if (!reply.match(/\d{2,} ?(rue|avenue|boulevard|place|route)/i)) {
        const searchQuery = reformulateQuery(previousUserMessage, userMessage);
        reply = await searchGoogle(searchQuery);
      }

      if (needExtraSearch(reply)) {
        const searchQuery = reformulateQuery(previousUserMessage, userMessage);
        reply = await searchGoogle(searchQuery);
      }

      const intro = `Merci pour votre question ! Voici ce que j'ai trouvé pour vous :<br><br>`;

      reply = reply
        .replace(/\*\*(.*?)\*\*/g, '**$1**')
        .replace(/1\./g, '<br>1.')
        .replace(/2\./g, '<br>2.')
        .replace(/3\./g, '<br>3.')
        .replace(/4\./g, '<br>4.')
        .replace(/5\./g, '<br>5.')
        .replace(/\u2022/g, '<br>•')
        .replace(/(https?:\/\/\S+)/g, '<br>👉 $1')
        .replace(/\n{2,}/g, '<br><br>');

      const buttonsHTML = `<br><br><button onclick="window.location.reload()">Poser une autre question</button><br><a href="https://wa.me/33633352067" target="_blank">Contacter via WhatsApp</a><br><a href="tel:+33633352067">Appeler Key Garden</a>`;
      const signature = `<br><br><div style="font-size: 0.9em; color: #555;">— Key Garden Conciergerie 🌿<br>Votre sejour en toute serenite</div>`;

      previousUserMessage = userMessage;

      return res.json({ reply: intro + reply + buttonsHTML + signature });
    } else {
      return res.json({ reply: "Je suis desole, je n'ai pas trouve cette information pour le moment." });
    }

  } catch (err) {
    console.error('Erreur API OpenAI:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Erreur du chatbot.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur actif sur le port ${PORT}`);
});
