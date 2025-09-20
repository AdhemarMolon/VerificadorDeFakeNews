// --- UI wiring ---
const modeButtons = [...document.querySelectorAll('.btn[data-mode]')];
let currentMode = 'full';
modeButtons.forEach(b=>{
  b.addEventListener('click', ()=>{
    modeButtons.forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    currentMode = b.dataset.mode;
  });
});

const btn = document.getElementById('check');
const result = document.getElementById('result');
const errorBox = document.getElementById('error');
const errorMsg = document.getElementById('errorMsg');
const labelPill = document.getElementById('labelPill');
const scoreFill = document.getElementById('scoreFill');
const scoreText = document.getElementById('scoreText');
const message = document.getElementById('message');
const reasonsUl = document.getElementById('reasons');
const sourcesDiv = document.getElementById('sources');

// --- lista de domínios confiáveis no front (espelho do backend)
const TRUSTED_DOMAINS = new Set([
  'g1.globo.com','aosfatos.org','piaui.folha.uol.com.br','boatos.org','e-farsas.com',
  'snopes.com','factcheck.org','poligrafo.sapo.pt',
  'bbc.com','reuters.com','apnews.com','nytimes.com','elpais.com',
  'agenciabrasil.ebc.com.br','estadao.com.br','folha.uol.com.br','uol.com.br',
  'nexojornal.com.br','cnnbrasil.com.br','veja.abril.com.br','band.uol.com.br'
]);
function isTrusted(url){
  try{
    const host = new URL(url).hostname.toLowerCase();
    if (TRUSTED_DOMAINS.has(host)) return true;
    // aceita subdomínios (ex.: noticias.uol.com.br)
    for (const d of TRUSTED_DOMAINS) if (host.endsWith('.'+d)) return true;
  }catch{}
  return false;
}

// --- helpers de UI ---
function setLoading(v){
  if(v){ btn.disabled = true; btn.innerHTML = '<span class="loading"></span> Analisando...'; }
  else { btn.disabled = false; btn.textContent = 'Checar agora'; }
}
function uiFromLabel(label){
  switch(label){
    case 'fake':       return { cls:'err',  text:'Não confiável', icon:'❌' };
    case 'duvidoso':   return { cls:'warn', text:'Suspeito',      icon:'⚠️' };
    case 'confiavel':  return { cls:'ok',   text:'Confiável',     icon:'✅' };
    default:           return { cls:'warn', text:'Suspeito',      icon:'⚠️' };
  }
}
function normalizeScore(label, raw, corroboration){
  let s = Math.max(0, Math.min(1, Number(raw)||0.5));
  const overall = corroboration?.overall;
  if (overall === 'inconclusiva' && label !== 'confiavel') s = Math.min(s, 0.7);
  if (label === 'duvidoso') s = Math.min(s, 0.7);
  if (label === 'confiavel') s = Math.max(0.6, Math.min(s, 0.98));
  if (label === 'fake') s = Math.max(0.7, Math.min(s, 0.99));
  return s;
}
function renderBar(label, score){
  const pct = Math.round(score * 100);
  scoreFill.className = label==='fake'?'score-err':label==='duvidoso'?'score-warn':'score-ok';
  scoreFill.style.width = pct + '%';
  scoreText.textContent = `confiança da avaliação: ${pct}%`;
}

// --- normaliza + filtra fontes ---
function normalizeSources(suggested) {
  if (!Array.isArray(suggested)) return [];
  const out = [];
  const seen = new Set();
  for (const it of suggested) {
    let url = null, title = '';
    if (typeof it === 'string') {
      url = it.trim();
    } else if (it && typeof it === 'object') {
      url = (it.url || it.link || it.href || '').trim();
      title = (it.title || it.source || it.name || '').toString().trim();
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (!isTrusted(url)) continue;                // <<=== filtro de confiança (front)
    if (seen.has(url)) continue;
    seen.add(url);
    let host = '';
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^www\./,'');
      if (!title) title = host;
    } catch { continue; }
    out.push({ title, url, host });
  }
  return out.slice(0, 8);
}

function renderSources(suggested) {
  sourcesDiv.innerHTML = '';
  const clean = normalizeSources(suggested);

  const wrap = document.createElement('div'); 
  wrap.style.marginTop = '10px';

  const heading = document.createElement('div');
  heading.className = 'tiny';
  heading.textContent = 'Confira também:';
  wrap.appendChild(heading);

  if (clean.length === 0) {
    const none = document.createElement('div');
    none.className = 'tiny';
    none.textContent = 'Nenhuma fonte confiável foi encontrada.';
    wrap.appendChild(none);
    sourcesDiv.appendChild(wrap);
    return;
  }

  clean.forEach(({title, url, host}) => {
    const card = document.createElement('div');
    card.className = 'source-card';

    const top = document.createElement('div');
    top.className = 'source-top';
    const favicon = document.createElement('img');
    favicon.className = 'source-ico';
    favicon.alt = '';
    favicon.referrerPolicy = 'no-referrer';
    favicon.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    const hostEl = document.createElement('span');
    hostEl.textContent = host;
    top.appendChild(favicon);
    top.appendChild(hostEl);

    const titleEl = document.createElement('a');
    titleEl.className = 'source-title';
    titleEl.href = url;
    titleEl.target = '_blank';
    titleEl.rel = 'noopener noreferrer';
    titleEl.textContent = title;

    const urlEl = document.createElement('a');
    urlEl.className = 'source-url';
    urlEl.href = url;
    urlEl.target = '_blank';
    urlEl.rel = 'noopener noreferrer';
    urlEl.textContent = url;

    card.appendChild(top);
    card.appendChild(titleEl);
    card.appendChild(urlEl);
    wrap.appendChild(card);
  });

  sourcesDiv.appendChild(wrap);
}

function renderUI(data){
  errorBox.style.display = 'none';
  result.style.display = 'block';

  const ui = uiFromLabel(data.label);
  const calibrated = normalizeScore(data.label, data.score, data.corroboration);

  labelPill.className = 'pill ' + ui.cls;
  labelPill.textContent = `${ui.icon} ${ui.text}`;
  renderBar(data.label, calibrated);

  message.textContent =
    data.label==='fake'
      ? 'Este conteúdo foi classificado como NÃO CONFIÁVEL. Evite compartilhar e verifique as fontes abaixo.'
      : data.label==='duvidoso'
      ? 'Este conteúdo está SUSPEITO. Confira fontes independentes abaixo.'
      : 'Este conteúdo parece CONFIÁVEL. Ainda assim, cheque as fontes.';

  reasonsUl.innerHTML = '';
  (data.reasons || []).slice(0,8).forEach(r=>{
    const li = document.createElement('li'); li.textContent = r; reasonsUl.appendChild(li);
  });

  renderSources(data.suggested_sources);
}

// --- ações do popup ---
btn.addEventListener('click', async () => {
  setLoading(true); result.style.display = 'none'; errorBox.style.display = 'none';
  try{
    chrome.runtime.sendMessage({ type: 'CHECAR_PAGINA', mode: currentMode }, (resp) => {
      setLoading(false);
      if (chrome.runtime.lastError) {
        errorMsg.textContent = chrome.runtime.lastError.message;
        errorBox.style.display = 'block';
        return;
      }
      if (!resp || !resp.ok) {
        errorMsg.textContent = (resp && resp.error) ? resp.error : 'Falha ao analisar a página.';
        errorBox.style.display = 'block';
        return;
      }
      renderUI(resp.data || {});
    });
  } catch(e){
    setLoading(false);
    errorMsg.textContent = String(e);
    errorBox.style.display = 'block';
  }
});

(async function loadLast(){
  const resp = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_LAST_RESULT' }, resolve);
  });
  if (resp?.ok && resp.lastResult) {
    renderUI(resp.lastResult);
  }
})();
