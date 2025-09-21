// ===== CONFIG DO BACKEND =====
const API_URL = "http://localhost:8787/classify"; // ajuste em produção
const API_KEY = ""; // opcional, ex.: "Bearer SEU_TOKEN"
// =============================


const TIMEOUT_MS_FULL = 90000; // página inteira
const TIMEOUT_MS_VIEW = 60000; // somente tela
const MAX_CHARS_FULL = 80000;
const MAX_CHARS_VIEW = 12000;


// ---- utils ----
function isInjectableUrl(url = "") {
if (!url) return false;
try {
const u = new URL(url);
const disallowed = ["chrome:", "edge:", "about:", "file:"].some(p => u.protocol.startsWith(p));
return !disallowed;
} catch { return false; }
}

async function exec(tabId, fileOrFunc, args = []) {
  try {
    if (typeof fileOrFunc === "function") {
      const [ret] = await chrome.scripting.executeScript({
        target: { tabId }, func: fileOrFunc, args
      });
      return { ok: true, result: ret?.result };
    } else {
      await chrome.scripting.executeScript({ target: { tabId }, files: [fileOrFunc] });
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- fetch com timeout + retry ----
async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url, opts, timeoutMs, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchWithTimeout(url, opts, timeoutMs);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`API ${r.status}${txt ? `: ${txt}` : ""}`);
      }
      return r;
    } catch (e) {
      lastErr = e;
      // backoff simples
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---- chamada à API ----
async function postToAPI(pagePayload, { mode = "full" } = {}) {
  const isView = mode === "viewport";
  const MAX = isView ? MAX_CHARS_VIEW : MAX_CHARS_FULL;
  const TIMEOUT = isView ? TIMEOUT_MS_VIEW : TIMEOUT_MS_FULL;

  const text = (pagePayload.text || "").slice(0, MAX);

  const payload = {
    task: "fake_news_classify",
    web_search: true,           // se quiser um "modo rápido", podemos expor isso no popup e mandar false aqui
    max_claims: isView ? 1 : 2,
    max_results: isView ? 3 : 6,
    page: { ...pagePayload, text }
  };

  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = API_KEY;

  const resp = await fetchWithRetry(
    API_URL,
    { method: "POST", headers, body: JSON.stringify(payload) },
    TIMEOUT,
    2
  );
  return resp.json();
}

// ---- coleta da aba ----
async function collectFromTab(tabId, mode = "full") {
  await exec(tabId, "content.js");
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: "COLETAR_MODO", mode }, resp => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(resp || { ok: false, error: "Sem resposta do content script." });
    });
  });
}

// ---- mensageria do popup ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "CHECAR_PAGINA") {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !isInjectableUrl(tab.url)) {
          return sendResponse({ ok: false, error: "Essa página não permite coleta de conteúdo." });
        }
        const mode = msg.mode || "full";
        const collected = await collectFromTab(tab.id, mode);
        if (!collected?.ok) {
          return sendResponse({ ok: false, error: collected?.error || "Falha ao coletar conteúdo" });
        }
        const data = await postToAPI(collected.payload, { mode });
        await chrome.storage.session.set({ lastResult: data, lastMode: mode });
        sendResponse({ ok: true, data });
      } catch (e) {
        const message = (e?.name === "AbortError" || String(e).includes("timeout"))
          ? "tempo esgotado ao contatar a API (tente novamente)."
          : String(e);
        sendResponse({ ok: false, error: message });
      }
    }

    if (msg?.type === "GET_LAST_RESULT") {
      const { lastResult = null, lastMode = null } =
        await chrome.storage.session.get(["lastResult", "lastMode"]);
      sendResponse({ ok: true, lastResult, lastMode });
    }
  })();
  return true;
});
