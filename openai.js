// Cliente minimo da OpenAI, sem dependencias extras (usa o fetch/FormData nativos do Node 20).
// A chave e o modelo sao configurados no /superadmin (card "Integração OpenAI").
// O que estiver salvo no painel tem prioridade; o .env (OPENAI_API_KEY, OPENAI_MODEL,
// OPENAI_TRANSCRIBE_MODEL) continua funcionando como reserva.

const { getSystemSetting } = require('./system-settings');

const DEFAULT_CHAT_MODEL = 'gpt-4.1-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

// Lidos a cada chamada: trocar a chave no painel vale na hora, sem reiniciar o servidor
function getApiKey() {
  return getSystemSetting('openai_api_key') || process.env.OPENAI_API_KEY || '';
}
function getChatModel() {
  return getSystemSetting('openai_model') || process.env.OPENAI_MODEL || DEFAULT_CHAT_MODEL;
}
function getTranscribeModel() {
  return getSystemSetting('openai_transcribe_model') || process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
}

function isConfigured() {
  return Boolean(getApiKey());
}

// Testa uma chave (a informada ou a salva) listando os modelos da conta
async function testKey(key) {
  const apiKey = key || getApiKey();
  if (!apiKey) throw new Error('Nenhuma chave informada');
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(await readError(response));
  return true;
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
  form.append('model', getTranscribeModel());
  form.append('language', 'pt');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}` },
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
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: getChatModel(),
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

module.exports = { isConfigured, transcribeAudio, chat, testKey, getApiKey, getChatModel, getTranscribeModel, DEFAULT_CHAT_MODEL };
