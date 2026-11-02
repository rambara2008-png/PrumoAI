// Vercel Serverless Function: /api/chat
// A chave da Groq fica SOMENTE aqui (variável de ambiente GROQ_API_KEY), nunca no HTML.

const MAX_MESSAGES = 12;
const MAX_CONTENT = 2000;
const MAX_SYSTEM = 3500;
const LIMIT_PER_MIN = 20;
const hits = new Map(); // limite simples por IP (reinicia quando a função "esfria")

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const allowed = process.env.ALLOWED_ORIGIN; // opcional, ex.: https://prumo.vercel.app
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return res.status(403).json({ error: 'Origem não permitida' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Servidor sem chave configurada' });

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch { body = null; }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'Requisição inválida' });
  }

  const messages = body.messages
    .slice(-MAX_MESSAGES)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT) }));
  if (messages.length === 0) return res.status(400).json({ error: 'Requisição inválida' });

  const system = typeof body.system === 'string' ? body.system.slice(0, MAX_SYSTEM) : '';
  const finalMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;

  // Tenta o modelo da variável GROQ_MODEL primeiro e, se ele não existir mais, os seguintes.
  const candidates = [process.env.GROQ_MODEL, 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
    .filter(Boolean)
    .filter((m, idx, arr) => arr.indexOf(m) === idx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    for (const model of candidates) {
      const payload = {
        model,
        messages: finalMessages,
        temperature: 0.7,
        max_tokens: 1000,
      };
      if (model.startsWith('openai/gpt-oss')) payload.reasoning_effort = 'low';
      if (body.json === true) payload.response_format = { type: 'json_object' };

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (r.ok) {
        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content || '';
        if (text.trim()) return res.status(200).json({ text });
        console.error('Resposta vazia do modelo', model);
        continue;
      }

      // Registra só o erro da Groq (nunca o conteúdo das conversas)
      const errText = (await r.text()).slice(0, 300);
      console.error('Groq status', r.status, 'modelo', model, errText);
      const modelProblem = r.status === 404 || (r.status === 400 && /model/i.test(errText));
      if (!modelProblem) break; // chave errada, limite etc.: não adianta trocar de modelo
    }
    return res.status(502).json({ error: 'Falha no provedor de IA' });
  } catch (e) {
    console.error('Erro ao chamar a Groq:', e.name);
    return res.status(502).json({ error: 'Falha no provedor de IA' });
  } finally {
    clearTimeout(timer);
  }
};
