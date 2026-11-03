// Vercel Serverless Function: /api/chat
// A chave da Groq fica SOMENTE no servidor (variável de ambiente GROQ_API_KEY), nunca exposta no HTML/front-end.

const MAX_MESSAGES = 12;
const MAX_CONTENT = 2000;
const MAX_SYSTEM = 3500;
const LIMIT_PER_MIN = 20;
const hits = new Map(); // Limite simples por IP (reinicia quando a função esfria)

// Função para controle de taxa de requisições (Rate Limiting)
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > LIMIT_PER_MIN;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  
  // Garante que apenas métodos POST sejam aceitos
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // Validação opcional de origem (CORS)
  const allowed = process.env.ALLOWED_ORIGIN; // ex.: https://prumo.vercel.app
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return res.status(403).json({ error: 'Origem não permitida' });
  }

  // Identificação de IP e verificação de limite de requisições
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });
  }

  // Verificação da API Key da Groq
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Servidor sem chave configurada' });
  }

  // Parsing e validação do corpo da requisição
  let body = req.body;
  try { 
    if (typeof body === 'string') body = JSON.parse(body); 
  } catch { 
    body = null; 
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'Requisição inválida' });
  }

  // Sanitização e limitação do tamanho das mensagens
  const messages = body.messages
    .slice(-MAX_MESSAGES)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT) }));

  if (messages.length === 0) {
    return res.status(400).json({ error: 'Requisição inválida' });
  }

  const system = typeof body.system === 'string' ? body.system.slice(0, MAX_SYSTEM) : '';
  
  // Montagem do payload para a API da Groq
  const payload = {
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    temperature: 0.7,
    max_tokens: 700,
  };

  if (body.json === true) {
    payload.response_format = { type: 'json_object' };
  }

  // Configuração de timeout da requisição (20 segundos)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        Authorization: `Bearer ${apiKey}` 
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!r.ok) {
      console.error('Groq status', r.status);
      return res.status(502).json({ error: 'Falha no provedor de IA' });
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text });

  } catch (e) {
    console.error('Erro ao chamar a Groq:', e.name);
    return res.status(502).json({ error: 'Falha no provedor de IA' });
  } finally {
    clearTimeout(timer);
  }
};
