// Cliente minimo da OpenAI, sem dependencias extras (usa o fetch/FormData nativos do Node 20).
// .env: OPENAI_API_KEY (obrigatoria), OPENAI_MODEL (padrao gpt-4.1-mini),
//       OPENAI_TRANSCRIBE_MODEL (padrao gpt-4o-mini-transcribe; pode usar whisper-1)

const API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

function isConfigured() {
  return Boolean(API_KEY);
}

async function readError(response) {
  const text = await response.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return data?.error?.message || text;
  } catch {
    return text || `OpenAI retornou ${response.status}`;
  }
}

// buffer: Buffer do audio (ogg/opus do WhatsApp funciona direto)
async function transcribeAudio(buffer, mimetype = 'audio/ogg') {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY não configurada');

  const ext = mimetype.includes('mpeg') ? 'mp3' : mimetype.includes('mp4') ? 'm4a' : mimetype.includes('wav') ? 'wav' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype.split(';')[0] }), `audio.${ext}`);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'pt');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form
  });
  if (!response.ok) throw new Error('Transcrição falhou: ' + await readError(response));

  const data = await response.json();
  return (data.text || '').trim();
}

// messages/tools no formato Chat Completions. Retorna a mensagem do assistente (pode ter tool_calls).
async function chat(messages, tools) {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY não configurada');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.4
    })
  });
  if (!response.ok) throw new Error('OpenAI falhou: ' + await readError(response));

  const data = await response.json();
  return data.choices?.[0]?.message || { role: 'assistant', content: '' };
}

module.exports = { isConfigured, transcribeAudio, chat };
