// Vercel Serverless Function: /api/chat
// Usa o Gemini (GEMINI_API_KEY). Se só existir GROQ_API_KEY, usa a Groq.
// As chaves ficam SOMENTE nas variáveis de ambiente da Vercel, nunca no HTML.

const MAX_MESSAGES = 12;
const MAX_CONTENT = 2000;
const MAX_SYSTEM = 3500;
const LIMIT_PER_MIN = 20;
const hits = new Map(); // limite simples por IP

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > LIMIT_PER_MIN;
}

// ---------- Gemini ----------
function toGeminiContents(messages) {
  // O Gemini espera começar por "user" e alternar. Junta turnos seguidos do mesmo papel
  // e transforma a(s) fala(s) inicial(is) do assistente em contexto da primeira resposta do usuário.
  const lead = [];
  let k = 0;
  while (k < messages.length && messages[k].role === 'assistant') lead.push(messages[k++].content);
  const rest = messages.slice(k);
  const out = [];
  rest.forEach((m, idx) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    let text = m.content;
    if (idx === 0 && lead.length) text = `(Pergunta anterior do assistente: "${lead.join(' ')}")\n${text}`;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].parts[0].text += '\n' + text;
    else out.push({ role, parts: [{ text }] });
  });
  return out;
}

async function callGemini({ apiKey, system, messages, json, signal }) {
  const candidates = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash']
    .filter(Boolean)
    .filter((m, i, a) => a.indexOf(m) === i);
  const contents = toGeminiContents(messages);
  if (!contents.length || contents[0].role !== 'user') return { error: 'bad-request' };

  for (const model of candidates) {
    const body = {
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (json) body.generationConfig.responseMimeType = 'application/json';

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });

    if (r.ok) {
      const data = await r.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
      if (text) return { text };
      console.error('Gemini sem texto', model, data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || '');
      return { error: 'empty' };
    }
    const errText = (await r.text()).slice(0, 300); // só o erro do provedor, nunca o conteúdo das conversas
    console.error('Gemini status', r.status, 'modelo', model, errText);
    const modelProblem = r.status === 404 || (r.status === 400 && /model/i.test(errText) && !/api key/i.test(errText));
    if (!modelProblem) break; // chave errada, limite etc.: trocar de modelo não ajuda
  }
  return { error: 'provider' };
}

// ---------- Groq (opcional) ----------
async function callGroq({ apiKey, system, messages, json, signal }) {
  const candidates = [process.env.GROQ_MODEL, 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
    .filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
  const finalMessages = system ? [{ role: 'system', content: system }, ...messages] : messages;
  for (const model of candidates) {
    const payload = { model, messages: finalMessages, temperature: 0.7, max_tokens: 1000 };
    if (model.startsWith('openai/gpt-oss')) payload.reasoning_effort = 'low';
    if (json) payload.response_format = { type: 'json_object' };
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal,
    });
    if (r.ok) {
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content || '';
      if (text.trim()) return { text };
      continue;
    }
    const errText = (await r.text()).slice(0, 300);
    console.error('Groq status', r.status, 'modelo', model, errText);
    if (!(r.status === 404 || (r.status === 400 && /model/i.test(errText)))) break;
  }
  return { error: 'provider' };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const allowed = process.env.ALLOWED_ORIGIN; // opcional, ex.: https://prumo-ten-bay.vercel.app
  if (allowed && req.headers.origin && req.headers.origin !== allowed) {
    return res.status(403).json({ error: 'Origem não permitida' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Muitas requisições. Aguarde um minuto.' });

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) return res.status(500).json({ error: 'Servidor sem chave configurada' });

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
  const json = body.json === true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const result = geminiKey
      ? await callGemini({ apiKey: geminiKey, system, messages, json, signal: controller.signal })
      : await callGroq({ apiKey: groqKey, system, messages, json, signal: controller.signal });
    if (result.text) return res.status(200).json({ text: result.text });
    return res.status(result.error === 'bad-request' ? 400 : 502).json({ error: 'Falha no provedor de IA' });
  } catch (e) {
    console.error('Erro ao chamar a IA:', e.name);
    return res.status(502).json({ error: 'Falha no provedor de IA' });
  } finally {
    clearTimeout(timer);
  }
};
