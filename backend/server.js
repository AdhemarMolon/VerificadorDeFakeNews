import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ============ CONFIG ============ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'serper').toLowerCase();
const SERPER_KEY = process.env.SERPER_KEY || '';
const BING_KEY = process.env.BING_KEY || '';
const SERPAPI_KEY = process.env.SERP_API_KEY || process.env.SERPAPI_KEY || '';

/** Grandes veículos/checadores confiáveis (adicione/edite à vontade) */
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

// axios com timeout p/ buscadores
const http = axios.create({ timeout: 15000 });

/* ============ Helpers ============ */
function hostFromUrl(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function isTrusted(url) {
  const host = hostFromUrl(url);
  if (!host) return false;
  // aceita host exato ou subdomínios de itens na lista
  for (const d of TRUST_SET) {
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

function quickHeuristics(page) {
  const t = ((page.title || '') + ' ' + (page.text || '')).normalize('NFC');
  const exclam = (t.match(/!/g) || []).length;
  const allcaps = (t.match(/\b[A-ZÁ-Ú]{5,}\b/g) || []).length;
  const clickbait = /\b(URGENTE|CHOCANTE|VOCÊ NÃO VAI ACREDITAR|IMPERDÍVEL|BOMBA|EXCLUSIVO)\b/i.test(t);
  const hasSources = /\b(fonte|refer(ê|e)ncia|estudo|doi\.org|scielo|pubmed|g1\.globo|agenciabrasil|bbc|reuters|apnews|nyt|elpais)\b/i.test(t);
  return { exclam, allcaps, clickbait, hasSources };
}
function withTimeout(promise, ms, label='operação') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))
  ]);
}

/* ============ Busca Web ============ */
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
      params: { q: query, engine: 'google', hl: 'pt-br', num: maxResults, api_key: SERPAPI_KEY }
    });
    return (r.data.organic_results || []).map(i => ({
      title: i.title, url: i.link, snippet: i.snippet
    }));
  }
  throw new Error('SEARCH_PROVIDER inválido');
}

/* ============ Extração de Claims ============ */
async function extractClaims(page, maxClaims = 2) {
  const text = (page.title ? page.title + '. ' : '') + (page.text || '');
  const r = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Extraia afirmações factuais checáveis, curtas e objetivas.' },
        { role: 'user', content:
`Extraia até ${maxClaims} afirmações factuais checáveis do texto abaixo.
Responda JSON {claims:[...]}.
Texto:
"""${text.slice(0, 6000)}"""` }
      ]
    }),
    40000,
    'openai/extractClaims'
  );
  try {
    const obj = JSON.parse(r.choices[0].message.content);
    return Array.isArray(obj.claims) ? obj.claims.slice(0, maxClaims) : [];
  } catch { return []; }
}

/* ============ Queries direcionadas ============ */
function buildQueriesForLabel(label, claim, page) {
  const y = (page.published_time || '').slice(0, 4);
  const yearHint = y ? ` ${y}` : '';
  const cleanClaim = claim.replace(/\s+/g, ' ').trim();

  const base = [`${cleanClaim}${yearHint}`, `"${cleanClaim}"${yearHint}`];

  if (label === 'fake' || label === 'duvidoso') {
    // Puxe para checadores primeiro
    const fcSites = [
      'site:g1.globo.com/fato-ou-fake', 'site:aosfatos.org',
      'site:piaui.folha.uol.com.br', 'site:boatos.org', 'site:e-farsas.com',
      'site:snopes.com', 'site:factcheck.org', 'site:poligrafo.sapo.pt'
    ].join(' OR ');
    return [
      `${cleanClaim} é falso OR boato OR montagem OR deepfake`,
      `${cleanClaim} desmentido OR checagem OR verificação`,
      `"${cleanClaim}" ${fcSites}`,
      `${cleanClaim} ${fcSites}`,
      ...base
    ];
  }

  const newsSites = [
    'site:bbc.com','site:reuters.com','site:apnews.com','site:nytimes.com',
    'site:elpais.com','site:agenciabrasil.ebc.com.br','site:estadao.com.br',
    'site:folha.uol.com.br','site:uol.com.br','site:nexojornal.com.br',
    'site:cnnbrasil.com.br','site:veja.abril.com.br','site:band.uol.com.br'
  ].join(' OR ');

  return [
    `"${cleanClaim}" ${newsSites}`,
    `${cleanClaim} ${newsSites}`,
    `${cleanClaim} confirmação OR detalhes OR cobertura`,
    ...base
  ];
}

/* ============ Rerank ============ */
async function rerankAgainstClaim(claim, candidates) {
  if (candidates.length === 0) return [];
  const prompt =
`Você é um verificador. Marque apenas os links que realmente tratam da MESMA afirmação abaixo
e diga se CORROBORAM (confirmam) ou CONTRADIZEM (desmentem).

Afirmação:
"${claim}"

Links:
${candidates.map((c, i) => `[${i+1}] ${c.title} — ${c.url}\n${c.snippet || ''}`).join('\n\n')}

Responda JSON:
{ keep:[{idx:number, stance:"corrobora"|"contradiz", reason:string }] }`;

  const r = await withTimeout(
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    }),
    40000,
    'openai/rerank'
  );

  let keep = [];
  try { keep = JSON.parse(r.choices[0].message.content)?.keep || []; } catch {}
  const out = [];
  for (const k of keep) {
    const c = candidates[k.idx - 1];
    if (!c) continue;
    out.push({ ...c, stance: k.stance, reason: k.reason });
  }
  return out;
}

/* ============ Corroboração + filtro confiável ============ */
async function corroborateTrustedOnly(label, page, maxClaims = 2, maxResults = 6) {
  const claims = await extractClaims(page, maxClaims);
  if (claims.length === 0) throw new Error('Não foi possível extrair afirmações checáveis.');

  const verdicts = [];
  const suggested = new Set(); // só confiáveis

  for (const claim of claims) {
    const queries = buildQueriesForLabel(label, claim, page);

    let bucket = [];
    const seen = new Set();
    try {
      for (const q of queries) {
        const rs = await webSearch(q, Math.ceil(maxResults/2));
        for (const r of rs) {
          if (!r?.url || !/^https?:/i.test(r.url)) continue;
          if (seen.has(r.url)) continue;
          seen.add(r.url);
          bucket.push(r);
        }
        if (bucket.length >= maxResults * 2) break;
      }
    } catch { bucket = []; }

    // manter só candidatos de domínios confiáveis já aqui
    bucket = bucket.filter(c => isTrusted(c.url));

    const filtered = await rerankAgainstClaim(claim, bucket).catch(() => []);
    const contradiz = filtered.filter(x => x.stance === 'contradiz');
    const corrobora = filtered.filter(x => x.stance === 'corrobora');

    let status = 'inconclusiva';
    if (contradiz.length > 0 && (label === 'fake' || label === 'duvidoso')) status = 'contradita';
    else if (corrobora.length > 0 && label === 'confiavel') status = 'corroborada';
    else if (contradiz.length > corrobora.length) status = 'contradita';
    else if (corrobora.length > contradiz.length) status = 'corroborada';

    const chosen = (status === 'contradita') ? contradiz : corrobora;
    chosen.slice(0, 6).forEach(s => {
      if (isTrusted(s.url)) suggested.add(JSON.stringify({ title: s.title, url: s.url }));
    });

    verdicts.push({
      claim,
      status,
      sources: chosen.slice(0, 6).map(s => ({ title: s.title, url: s.url }))
    });
  }

  const pos = verdicts.filter(v => v.status === 'corroborada').length;
  const neg = verdicts.filter(v => v.status === 'contradita').length;
  const overall = neg > pos ? 'contradita' : pos > neg ? 'corroborada' : 'inconclusiva';
  const suggested_sources = [...suggested].map(s => JSON.parse(s));

  return { verdicts, overall, suggested_sources };
}

function calibrateScore(label, score, corroboration) {
  let s = Math.max(0, Math.min(1, Number(score) || 0.5));
  if (corroboration?.overall === 'inconclusiva') {
    if (label === 'duvidoso') s = Math.min(s, 0.6);
    if (label === 'confiavel') s = Math.min(s, 0.85);
    if (label === 'fake') s = Math.min(s, 0.9);
    return s;
  }
  if (label === 'duvidoso') s = Math.min(s, 0.7);
  if (label === 'confiavel') s = Math.max(0.6, Math.min(s, 0.98));
  if (label === 'fake') s = Math.max(0.7, Math.min(s, 0.99));
  return s;
}

/* ============ Endpoint principal ============ */
app.post('/classify', async (req, res) => {
  const overallTimeout = withTimeout(new Promise(async (resolve) => {
    try {
      const { page, web_search = true, max_claims = 2, max_results = 6 } = req.body || {};
      if (!page || !page.text) return resolve(res.status(400).json({ error: 'payload inválido' }));

      if (web_search) {
        if (SEARCH_PROVIDER === 'serper' && !SERPER_KEY) return resolve(res.status(400).json({ error: 'SERPER_KEY ausente.' }));
        if (SEARCH_PROVIDER === 'bing' && !BING_KEY) return resolve(res.status(400).json({ error: 'BING_KEY ausente.' }));
        if (SEARCH_PROVIDER === 'serpapi' && !SERPAPI_KEY) return resolve(res.status(400).json({ error: 'SERPAPI_KEY ausente.' }));
      }

      const text = page.text.slice(0, 40000);
      const h = quickHeuristics({ title: page.title, text });

      const base = await withTimeout(
        openai.chat.completions.create({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Classifique notícia como "fake", "duvidoso" ou "confiavel".' },
            { role: 'user', content:
`Considere estilo do texto, presença de fontes, tom sensacionalista, contradições lógicas etc.
Heurísticas rápidas: ${JSON.stringify(h)}
Responda JSON: {label:"fake|duvidoso|confiavel", score:0..1, reasons:[...]}
TEXTO:
"""${(page.title ? page.title + '. ' : '') + text}"""` }
          ]
        }),
        40000,
        'openai/classify'
      );

      let baseObj = { label: 'duvidoso', score: 0.6, reasons: ['Avaliação padrão.'] };
      try { baseObj = JSON.parse(base.choices[0].message.content); } catch {}

      let corroboration = { overall: 'inconclusiva', verdicts: [], suggested_sources: [] };
      if (web_search) {
        try {
          corroboration = await corroborateTrustedOnly(
            baseObj.label, page, max_claims, max_results
          );
        } catch {
          corroboration = { overall: 'inconclusiva', verdicts: [], suggested_sources: [] };
        }
      }

      const finalScore = calibrateScore(baseObj.label, baseObj.score, corroboration);

      return resolve(res.json({
        label: baseObj.label,
        score: finalScore,
        reasons: baseObj.reasons || [],
        checks: { quick_heuristics: h },
        suggested_sources: corroboration.suggested_sources || [],
        corroboration: {
          overall: corroboration.overall,
          summary: `Busca ${corroboration.overall}.`,
          verdicts: corroboration.verdicts
        }
      }));
    } catch (e) {
      return resolve(res.status(500).json({ error: String(e.message || e) }));
    }
  }), 60000, 'request');

  await overallTimeout.catch(() => {});
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Fake Checker backend na porta ${PORT}`));
