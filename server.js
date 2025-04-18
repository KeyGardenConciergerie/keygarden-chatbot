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

// ➡️ Sert ton index.html à la racine
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

let threadId = null;
// ➡️ Détecter si la réponse est trop vague
fufunction needExtraSearch(text) {
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


let previousUserMessage = null;

// 🔎 Fonction de recherche sur Internet via Serper
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

// 🚀 Route principale du chatbot
app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;

  try {
    if (["oui", "vas-y", "ok", "d’accord", "allez-y"].includes(userMessage.toLowerCase().trim())) {
      const result = await searchGoogle(previousUserMessage || 'informations Coupvray');
      return res.json({ reply: result });
    }

    async function ensureThreadReady() {
  try {
    if (threadId) {
      // Vérifie s’il y a un run actif sur le thread actuel
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
        console.log('⚡ Run actif détecté ➔ Création d\'un nouveau thread');
        threadId = null; // Reset thread si bloqué
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
      console.log('🧵 Nouveau thread créé :', threadId);
    }

  } catch (err) {
    console.error('Erreur ensureThreadReady:', err.response?.data || err.message);
    throw new Error("Impossible de créer ou récupérer un thread.");
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
          const result = await searchGoogle(args.query);
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

        runStatus = 'in_progress';
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
        }
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

  const intro = `Merci pour votre question ! Voici ce que j'ai trouvé pour vous :<br><br>`;

  // ➡️ Si la réponse est vague ➔ lancer une recherche Google automatique
  if (needExtraSearch(reply)) {
    console.log('🔎 Réponse vague détectée ➔ Lancement d’une recherche Google...');
    const googleResult = await searchGoogle(userMessage || 'informations Coupvray');
    reply = googleResult;
  }

  // ➡️ Mise en page jolie
  reply = reply
    .replace(/\*\*(.*?)\*\*/g, '**$1**')
    .replace(/1\./g, '<br>1.')
    .replace(/2\./g, '<br>2.')
    .replace(/3\./g, '<br>3.')
    .replace(/4\./g, '<br>4.')
    .replace(/5\./g, '<br>5.')
    .replace(/•/g, '<br>•')
    .replace(/(https?:\/\/\S+)/g, '<br>👉 $1')
    .replace(/\n{2,}/g, '<br><br>');

  const buttonsHTML = `
    <br><br>
    <button style="padding: 8px 16px; background-color: #00AEEF; color: white; border: none; border-radius: 6px; cursor: pointer; margin-right: 10px;" onclick="window.location.reload()">Poser une autre question</button>
    <a href="https://wa.me/33633352067" target="_blank" style="text-decoration: none;">
      <button style="padding: 8px 16px; background-color: #25D366; color: white; border: none; border-radius: 6px; cursor: pointer; margin-right: 10px;">Contacter via WhatsApp</button>
    </a>
    <a href="tel:+33633352067" style="text-decoration: none;">
      <button style="padding: 8px 16px; background-color: #28A745; color: white; border: none; border-radius: 6px; cursor: pointer;">Appeler Key Garden</button>
    </a>`;

  const signature = `<br><br><div style="font-size: 0.9em; color: #555;">— Key Garden Conciergerie 🌿<br>Votre séjour en toute sérénité</div>`;

  previousUserMessage = userMessage;

  return res.json({ reply: intro + reply + buttonsHTML + signature });
}
else {
      return res.json({ reply: "Je suis désolé, je n’ai pas trouvé cette information pour le moment. Souhaitez-vous que je fasse une recherche sur Internet pour vous aider davantage ?" });
    }
  } catch (err) {
    console.error('Erreur API OpenAI :', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Erreur du chatbot.' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur actif sur le port ${PORT}`);
});
