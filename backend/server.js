import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Provedores de busca
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || '').toLowerCase();
const SERPER_KEY = process.env.SERPER_KEY || '';
const BING_KEY = process.env.BING_KEY || '';
const SERPAPI_KEY = process.env.SERP_API_KEY || process.env.SERPAPI_KEY || '';

// Domínios confiáveis (ajuste livre)
const TRUSTED_DOMAINS = [
  'g1.globo.com', 'agenciabrasil.ebc.com.br', 'bbc.com', 'reuters.com',
  'apnews.com', 'nytimes.com', 'elpais.com', 'estadao.com.br',
  'folha.uol.com.br', 'uol.com.br', 'nexojornal.com.br'
];

// Heurísticas baratas
function quickHeuristics(page) {
  const t = ((page.title || '') + ' ' + (page.text || '')).normalize('NFC');
  const exclam = (t.match(/!/g) || []).length;
  const allcaps = (t.match(/\b[A-ZÁ-Ú]{5,}\b/g) || []).length;
  const clickbait = /\b(URGENTE|CHOCANTE|VOCÊ NÃO VAI ACREDITAR|IMPERDÍVEL|BOMBA|EXCLUSIVO)\b/i.test(t);
  const hasSources = /\b(fonte|refer(ê|e)ncia|estudo|doi\.org|scielo|pubmed|g1\.globo|agenciabrasil|bbc|reuters|associated press|apnews|nyt|elpais)\b/i.test(t);
  return { exclam, allcaps, clickbait, hasSources };
}

/* =================== BUSCA WEB =================== */
async function webSearch(query, maxResults = 6) {
  if (SEARCH_PROVIDER === 'serper') {
    if (!SERPER_KEY) throw new Error('SERPER_KEY ausente (busca obrigatória).');
    const r = await axios.post(
      'https://google.serper.dev/search',
      { q: query, gl: 'br', hl: 'pt-BR', num: maxResults },
      { headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' } }
    );
    const items = (r.data.organic || []).slice(0, maxResults).map(i => ({
      title: i.title, url: i.link, snippet: i.snippet
    }));
    return items;
  }

  if (SEARCH_PROVIDER === 'bing') {
    if (!BING_KEY) throw new Error('BING_KEY ausente (busca obrigatória).');
    const r = await axios.get('https://api.bing.microsoft.com/v7.0/search', {
      params: { q: query, count: maxResults, mkt: 'pt-BR', safesearch: 'Moderate' },
      headers: { 'Ocp-Apim-Subscription-Key': BING_KEY }
    });
    return (r.data.webPages?.value || []).map(i => ({
      title: i.name, url: i.url, snippet: i.snippet
    }));
  }

  if (SEARCH_PROVIDER === 'serpapi') {
    if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY ausente (busca obrigatória).');
    const r = await axios.get('https://serpapi.com/search.json', {
      params: { q: query, engine: 'google', hl: 'pt-br', num: maxResults, api_key: SERPAPI_KEY }
    });
    return (r.data.organic_results || []).map(i => ({
      title: i.title, url: i.link, snippet: i.snippet
    }));
  }

  throw new Error('SEARCH_PROVIDER inválido. Use serper, bing ou serpapi.');
}

/* ======= Afirmações checáveis ======= */
async function extractClaims(page, maxClaims = 2) {
  const text = (page.title ? page.title + '. ' : '') + (page.text || '');
  const r = await openai.chat.completions.create({
    model: 'gpt-5-nano',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Extraia afirmações factuais checáveis, curtas e objetivas.' },
      { role: 'user', content:
`Extraia até ${maxClaims} afirmações factuais checáveis do texto abaixo.
Responda JSON {claims:[...]}.
Texto:
"""${text.slice(0, 6000)}"""` }
    ]
  });
  try {
    const obj = JSON.parse(r.choices[0].message.content);
    return Array.isArray(obj.claims) ? obj.claims.slice(0, maxClaims) : [];
  } catch {
    return [];
  }
}

/* ======= Corroboração com busca ======= */
async function corroborateWithSearch(page, maxClaims = 2, maxResults = 6) {
  const claims = await extractClaims(page, maxClaims);
  if (claims.length === 0) throw new Error('Não foi possível extrair afirmações checáveis.');

  const packs = [];
  for (const claim of claims) {
    const results = await webSearch(claim, maxResults);
    const trusted = results.filter(r => TRUSTED_DOMAINS.some(d => (r.url || '').includes(d))).slice(0, 4);
    const others = results.filter(r => !trusted.includes(r)).slice(0, 2);
    packs.push({ claim, evidence: [...trusted, ...others] });
  }

  const judge = await openai.chat.completions.create({
    model: 'gpt-5-nano',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Compare afirmações e evidências e classifique cada uma.' },
      { role: 'user', content:
`Classifique cada afirmação como "corroborada", "contradita" ou "inconclusiva".
Responda JSON:
{summary:string, verdicts:[{claim, status, sources:[{url,title}]}], overall:"corroborada|contradita|inconclusiva"}
DADOS:
${JSON.stringify(packs, null, 2)}` }
    ]
  });

  let out;
  try { out = JSON.parse(judge.choices[0].message.content); }
  catch { out = { overall: 'inconclusiva', summary: 'Falha ao interpretar resultados', verdicts: [] }; }

  return { claims, packs, verdict: out };
}

/* ======= Calibração de score ======= */
function calibrateScore(label, score, corroboration) {
  let s = Math.max(0, Math.min(1, Number(score) || 0.5));

  // Se a busca foi inconclusiva, evite “certeza absoluta”
  if (corroboration?.overall === 'inconclusiva') {
    if (label === 'duvidoso') s = Math.min(s, 0.6);
    if (label === 'confiavel') s = Math.min(s, 0.85);
    if (label === 'fake') s = Math.min(s, 0.9);
    return s;
  }

  // Limites por rótulo (para UX consistente)
  if (label === 'duvidoso') s = Math.min(s, 0.7);           // nunca 100% pra "duvidoso"
  if (label === 'confiavel') s = Math.max(0.6, Math.min(s, 0.98));
  if (label === 'fake') s = Math.max(0.7, Math.min(s, 0.99));
  return s;
}

/* =================== CLASSIFY =================== */
app.post('/classify', async (req, res) => {
  try {
    const { page, web_search = true, max_claims = 2, max_results = 6 } = req.body || {};
    if (!page || !page.text) return res.status(400).json({ error: 'payload inválido' });

    // Busca web obrigatória
    if (web_search) {
      if (SEARCH_PROVIDER === 'serper' && !SERPER_KEY) return res.status(400).json({ error: 'SERPER_KEY ausente.' });
      if (SEARCH_PROVIDER === 'bing' && !BING_KEY) return res.status(400).json({ error: 'BING_KEY ausente.' });
      if (SEARCH_PROVIDER === 'serpapi' && !SERPAPI_KEY) return res.status(400).json({ error: 'SERPAPI_KEY ausente.' });
    }

    const text = page.text.slice(0, 40000);
    const h = quickHeuristics({ title: page.title, text });

    // A) avaliação base (estilo/linguagem/fontes)
    const base = await openai.chat.completions.create({
      model: 'gpt-4.1-nano',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system',
          content: `Você é verificador de fatos. Classifique:
- "fake": afirmações falsas/enganosas;
- "duvidoso": sinais de manipulação, omissões ou falta de fontes;
- "confiavel": verificável, com fontes ou de veículos reconhecidos.
Explique. Responda JSON {label, score, reasons[], checks{...}}.` },
        { role: 'user', content:
`META:
- URL: ${page.url}
- DOMÍNIO: ${page.domain}
- TÍTULO: ${page.title}
- DESCRIÇÃO: ${page.meta?.description}
- AUTOR: ${page.author}
- PUBLICADO_EM: ${page.published_time}
- HEADERS.h1: ${(page.headings?.h1 || []).join(' | ')}

HEURÍSTICAS LOCAIS:
${JSON.stringify(h)}

TEXTO (truncado ${text.length}/${(page.text||'').length} chars):
"""${text}"""` }
      ]
    });

    let firstPass;
    try { firstPass = JSON.parse(base.choices[0].message.content); }
    catch { firstPass = { label: 'duvidoso', score: 0.5, reasons: ['Falha ao parsear JSON'] }; }

    // B) pesquisa web
    let corroboration = null;
    if (web_search) {
      const cor = await corroborateWithSearch({ ...page, text }, max_claims, max_results);
      corroboration = cor.verdict;
    }

    // C) fusão das visões
    const fused = await openai.chat.completions.create({
      model: 'gpt-5-nano',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Combine avaliação base e corroboração em um veredito final.' },
        { role: 'user', content:
`Retorne JSON {label, score, reasons[], checks:{...}, suggested_sources:[...]}.
Regras:
- Evidência confiável que contradiz => "fake".
- Evidência forte confirmando => "confiavel".
- Sem evidência => "duvidoso".

Avaliação inicial:
${JSON.stringify(firstPass, null, 2)}

Corroboração:
${JSON.stringify(corroboration, null, 2)}` }
      ]
    });

    let finalOut;
    try { finalOut = JSON.parse(fused.choices[0].message.content); }
    catch { finalOut = firstPass; }

    // Links confiáveis das buscas (se houver)
    const trustedLinks = [];
    if (corroboration?.verdicts) {
      for (const v of corroboration.verdicts) {
        for (const s of (v.sources || [])) {
          if (TRUSTED_DOMAINS.some(d => (s.url || '').includes(d))) {
            trustedLinks.push(s.url);
          }
        }
      }
    }

    // Calibra o score para evitar "100%" em casos duvidosos
    const label = ['fake','duvidoso','confiavel'].includes(finalOut.label) ? finalOut.label : (firstPass.label || 'duvidoso');
    const rawScore = typeof finalOut.score === 'number' ? finalOut.score : (firstPass.score || 0.5);
    const score = calibrateScore(label, rawScore, corroboration);

    return res.json({
      label,
      score,
      reasons: Array.isArray(finalOut.reasons) ? finalOut.reasons.slice(0,6) : (firstPass.reasons || []),
      // Mantemos checks para telemetria/depuração, mas o popup não exibirá
      checks: { ...(firstPass.checks || {}), ...(finalOut.checks || {}), quick_heuristics: h },
      suggested_sources: [ ...(finalOut.suggested_sources || []), ...trustedLinks ].slice(0,8),
      corroboration: corroboration || null
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

app.get('/', (_req, res) => res.send('Fake Checker backend OK'));
const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Fake Checker backend na porta ${port}`));
