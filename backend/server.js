import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

/* =========================
   App básico e middlewares
========================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* =========================
        Configuração
========================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
function geminiModel() {
  return genAI.getGenerativeModel({ model: GEMINI_MODEL });
}

const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'serper').toLowerCase(); // serper | bing | serpapi
const SERPER_KEY = process.env.SERPER_KEY || '';
const BING_KEY = process.env.BING_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const API_AUTH = process.env.API_AUTH || ''; // opcional: "Bearer <token>"

const http = axios.create({ timeout: 15000 });

/* =========================
      Domínios confiáveis
========================= */
const TRUSTED_DOMAINS = [
  // checadores
  'g1.globo.com',         // inclui /fato-ou-fake
  'aosfatos.org',
  'piaui.folha.uol.com.br',
  'boatos.org',
  'e-farsas.com',
  'snopes.com',
  'factcheck.org',
  'poligrafo.sapo.pt',

  // veículos de referência
  'bbc.com',
  'reuters.com',
  'apnews.com',
  'nytimes.com',
  'elpais.com',
  'agenciabrasil.ebc.com.br',
  'estadao.com.br',
  'folha.uol.com.br',
  'uol.com.br',
  'nexojornal.com.br',
  'cnnbrasil.com.br',
  'veja.abril.com.br',
  'band.uol.com.br'
];
const TRUST_SET = new Set(TRUSTED_DOMAINS);

/* =========================
            Utils
========================= */
function onlyHost(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

function domainIsTrusted(url) {
  const host = onlyHost(url);
  if (!host) return false;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.');
    if (TRUST_SET.has(cand)) return true;
  }
  return false;
}

function quickHeuristics(page) {
  const { title = '', text = '' } = page || {};
  const t = (title + ' ' + text).toLowerCase();
  const sensa = /URGENTE|CHOCANTE|VOCÊ NÃO VAI ACREDITAR|BOMBA|ESCÂNDALO|\!{2,}/i.test(title);
  const manyExclam = (title.match(/\!/g) || []).length >= 3;
  const hasFonte = /fonte:|referência:|source:/i.test(text);
  const hasCite = /(http|www\.)/i.test(text);
  return { sensa, manyExclam, hasFonte, hasCite };
}

async function withTimeout(promise, ms, label = 'task') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))
  ]);
}

/* =========================
       Gemini — helper
========================= */
async function geminiJson(prompt, timeoutLabel) {
  const model = geminiModel();
  const r = await withTimeout(
    model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    }),
    40000,
    timeoutLabel
  );
  const txt = r.response.text();
  try { return JSON.parse(txt); } catch { return null; }
}

/* =========================
         Busca Web
========================= */
async function webSearch(query, maxResults = 6) {
  if (SEARCH_PROVIDER === 'serper') {
    if (!SERPER_KEY) throw new Error('SERPER_KEY ausente');
    const r = await http.post(
      'https://google.serper.dev/search',
      { q: query, gl: 'br', hl: 'pt-BR', num: maxResults },
      { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' } }
    );
    return (r.data.organic || []).slice(0, maxResults).map(i => ({
      title: i.title, url: i.link, snippet: i.snippet
    }));
  }

  if (SEARCH_PROVIDER === 'bing') {
    if (!BING_KEY) throw new Error('BING_KEY ausente');
    const r = await http.get('https://api.bing.microsoft.com/v7.0/search', {
      params: { q: query, count: maxResults, mkt: 'pt-BR', safesearch: 'Moderate' },
      headers: { 'Ocp-Apim-Subscription-Key': BING_KEY }
    });
    return (r.data.webPages?.value || []).map(i => ({
      title: i.name, url: i.url, snippet: i.snippet
    }));
  }

  if (SEARCH_PROVIDER === 'serpapi') {
    if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY ausente');
    const r = await http.get('https://serpapi.com/search.json', {
      params: { engine: 'google', q: query, num: maxResults, hl: 'pt-BR', gl: 'br', api_key: SERPAPI_KEY }
    });
    return (r.data.organic_results || []).slice(0, maxResults).map(i => ({
      title: i.title, url: i.link, snippet: i.snippet
    }));
  }

  throw new Error(`SEARCH_PROVIDER inválido: ${SEARCH_PROVIDER}`);
}

/* =========================
    Extração de afirmações
========================= */
async function extractClaims(page, maxClaims = 2) {
  const text = (page.title ? page.title + '. ' : '') + (page.text || '');
  const obj = await geminiJson(
    `Extraia até ${maxClaims} afirmações factuais checáveis, curtas e objetivas.
Responda **apenas** JSON no formato: {"claims":["..."]}
Texto:
"""${text.slice(0, 6000)}"""`,
    'gemini/extractClaims'
  );
  return Array.isArray(obj?.claims) ? obj.claims.slice(0, maxClaims) : [];
}

/* =========================
  Re-rank / rótulo por claim
========================= */
async function rerankAgainstClaim(claim, candidates) {
  if (candidates.length === 0) return [];
  const prompt =
`Você é um verificador. Marque apenas os links que realmente tratam da MESMA afirmação abaixo
e diga se CORROBORAM (confirmam) ou CONTRADIZEM (desmentem).

Afirmação:
"${claim}"

Links:
${candidates.map((c, i) => `[${i + 1}] ${c.title} — ${c.url}\n${c.snippet || ''}`).join('\n\n')}

Responda JSON:
{ "keep":[{"idx":number, "stance":"corrobora"|"contradiz", "reason":string }] }`;

  const obj = await geminiJson(prompt, 'gemini/rerank');
  const keep = Array.isArray(obj?.keep) ? obj.keep : [];
  const out = [];
  for (const k of keep) {
    const c = candidates[k.idx - 1];
    if (!c) continue;
    out.push({ ...c, stance: k.stance, reason: k.reason });
  }
  return out;
}

/* =========================
  Corroboração com confiáveis
========================= */
async function corroborateTrustedOnly(_label, page, maxClaims = 2, maxResults = 6) {
  const claims = await extractClaims(page, maxClaims);
  if (claims.length === 0) throw new Error('Não foi possível extrair afirmações checáveis.');

  const verdicts = [];
  for (const claim of claims) {
    // viés pró confiáveis por query
    const q = `${claim} site:g1.globo.com OR site:aosfatos.org OR site:piaui.folha.uol.com.br OR site:boatos.org OR site:e-farsas.com OR site:bbc.com OR site:reuters.com OR site:apnews.com`;
    const results = await webSearch(q, maxResults);
    const filtered = results.filter(r => domainIsTrusted(r.url));
    const ranked = await rerankAgainstClaim(claim, filtered);
    verdicts.push({ claim, sources: ranked });
  }

  const overall = (function () {
    const hasContra = verdicts.some(v => v.sources.some(s => s.stance === 'contradiz'));
    const hasCorro = verdicts.some(v => v.sources.some(s => s.stance === 'corrobora'));
    if (hasContra && !hasCorro) return 'contradizida';
    if (hasCorro && !hasContra) return 'corroborada';
    if (hasContra && hasCorro) return 'mista';
    return 'inconclusiva';
  })();

  return { overall, verdicts };
}

/* =========================
       Endpoint principal
========================= */
app.post('/classify', async (req, res) => {
  try {
    if (API_AUTH) {
      const auth = req.headers['authorization'] || '';
      if (auth !== API_AUTH) return res.status(401).json({ error: 'unauthorized' });
    }

    const { page, web_search = true, max_claims = 2, max_results = 6 } = req.body || {};
    if (!page || !page.text) return res.status(400).json({ error: 'payload inválido' });

    // chaves de busca exigidas caso a flag esteja true
    if (web_search) {
      if (SEARCH_PROVIDER === 'serper' && !SERPER_KEY) return res.status(400).json({ error: 'SERPER_KEY ausente.' });
      if (SEARCH_PROVIDER === 'bing' && !BING_KEY) return res.status(400).json({ error: 'BING_KEY ausente.' });
      if (SEARCH_PROVIDER === 'serpapi' && !SERPAPI_KEY) return res.status(400).json({ error: 'SERPAPI_KEY ausente.' });
    }

    const text = String(page.text).slice(0, 40000);
    const h = quickHeuristics({ title: page.title, text });

    const baseObj = await geminiJson(
      `Classifique o texto como "fake", "duvidoso" ou "confiavel".
Leve em conta tom sensacionalista, presença de fontes, contradições e as heurísticas abaixo.
Heurísticas rápidas: ${JSON.stringify(h)}
Responda **apenas** JSON no formato:
{"label":"fake|duvidoso|confiavel","score":0..1,"reasons":["..."]}
TEXTO:
"""${(page.title ? page.title + '. ' : '') + text}"""`,
      'gemini/classify'
    ) || { label: 'duvidoso', score: 0.6, reasons: ['Avaliação padrão.'] };

    // Ajuste leve do score conforme heurísticas
    let score = Number(baseObj.score) || 0.6;
    if (h.sensa || h.manyExclam) score = Math.max(0, score - 0.1);
    if (h.hasFonte || h.hasCite) score = Math.min(1, score + 0.05);

    let corroboration = { overall: 'inconclusiva', verdicts: [] };
    if (web_search) {
      try {
        corroboration = await corroborateTrustedOnly(baseObj.label, page, max_claims, max_results);
      } catch {
        // mantém inconclusiva silenciosamente
      }
    }

    const suggested_sources = [];
    for (const v of corroboration.verdicts) {
      for (const s of v.sources) {
        if (domainIsTrusted(s.url)) suggested_sources.push({ title: s.title, url: s.url, stance: s.stance });
      }
    }

    return res.json({
      label: baseObj.label || 'duvidoso',
      score: Number(score.toFixed(2)),
      reasons: Array.isArray(baseObj.reasons) ? baseObj.reasons : ['Avaliação automática.'],
      heuristics: h,
      suggested_sources: suggested_sources.slice(0, 8),
      corroboration: {
        overall: corroboration.overall,
        summary: `Busca ${corroboration.overall}.`,
        verdicts: corroboration.verdicts
      }
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
           Start
========================= */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Fake Checker backend na porta ${PORT}`));
