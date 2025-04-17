const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

let threadId = null;
let previousUserMessage = null; // pour récupérer la requête précédente si l’utilisateur dit "oui"

// 🔎 Fonction de recherche internet via Serper
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
    // ✅ Si l'utilisateur dit "oui" ➔ relance la dernière recherche
    if (["oui", "vas-y", "ok", "d’accord", "allez-y"].includes(userMessage.toLowerCase().trim())) {
      const result = await searchGoogle(previousUserMessage || 'informations Coupvray');
      return res.json({ reply: result });
    }

    // ✅ Création du thread si pas encore fait
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
    }

    // ✅ Envoi du message utilisateur
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

    // ✅ Lancer un run assistant
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

    // ✅ Attendre que le run se termine
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

    // ✅ Gestion des outils appelés par l'assistant (recherche google par exemple)
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

        // Re-attendre que le run se termine
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

    // ✅ Récupération de la réponse finale
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

      // ✅ Nettoyer les balises inutiles 【xx†source】
      reply = reply.replace(/【.*?†.*?】/g, '').trim();

      // ✅ Ajouter intro amicale
      const personalizedIntro = `Merci pour votre question ! Voici ce que j'ai trouvé pour vous :<br><br>`;

      // ✅ Formater joliment la réponse
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

      // ✅ Ajouter boutons à la fin
      const buttonsHTML = `
        <br><br>
        <button style="padding: 8px 16px; background-color: #00AEEF; color: white; border: none; border-radius: 6px; cursor: pointer; margin-right: 10px;" onclick="window.location.reload()">Poser une autre question</button>
        <a href="https://wa.me/33633352067" target="_blank" style="text-decoration: none;">
          <button style="padding: 8px 16px; background-color: #25D366; color: white; border: none; border-radius: 6px; cursor: pointer; margin-right: 10px;">Contacter via WhatsApp</button>
        </a>
        <a href="tel:+33633352067" style="text-decoration: none;">
          <button style="padding: 8px 16px; background-color: #28A745; color: white; border: none; border-radius: 6px; cursor: pointer;">Appeler Key Garden</button>
        </a>
      `;

      // ✅ Ajouter signature
      const signature = `<br><br><div style="font-size: 0.9em; color: #555;">— Key Garden Conciergerie 🌿<br>Votre séjour en toute sérénité</div>`;

      previousUserMessage = userMessage;

      return res.json({ reply: personalizedIntro + reply + buttonsHTML + signature });
    } else {
      return res.json({ reply: "Je suis désolé, je n’ai pas trouvé cette information pour le moment. Souhaitez-vous que je fasse une recherche sur Internet pour vous aider davantage ?" });
    }
  } catch (err) {
    console.error('Erreur API OpenAI :', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Erreur du chatbot.' });
  }
});

// ✅ Lancer le serveur
app.listen(PORT, () => {
  console.log(`Serveur actif sur le port ${PORT}`);
});
