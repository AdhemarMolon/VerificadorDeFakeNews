// ===== CONFIG DO BACKEND =====
const API_URL = "http://localhost:8787/classify"; // ajuste em produção
const API_KEY = ""; // opcional, ex.: "Bearer SEU_TOKEN"
// =============================

const TIMEOUT_MS_FULL = 45000;     // página inteira
const TIMEOUT_MS_VIEW = 30000;     // somente tela (mais rápido)
const MAX_CHARS_FULL = 80000;      // limite de texto enviado
const MAX_CHARS_VIEW = 12000;

// Util: só permite injetar em páginas http(s) normais
function isInjectableUrl(url = "") {
  if (!url) return false;
  try {
    const u = new URL(url);
    const disallowed = ["chrome:", "edge:", "about:", "chrome-extension:"];
    if (disallowed.some(p => u.protocol.startsWith(p))) return false;
    if (u.hostname.endsWith("chrome.google.com")) return false; // web store
    if (u.pathname.endsWith(".pdf")) return false;              // pdf viewer
    return true;
  } catch { return false; }
}

// Executa script/arquivo dentro da aba de forma segura
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

// Chamada à API com timeout e limite de tamanho de texto
async function postToAPI(pagePayload, { mode = "full" } = {}) {
  const isView = mode === "viewport";
  const MAX = isView ? MAX_CHARS_VIEW : MAX_CHARS_FULL;
  const TIMEOUT = isView ? TIMEOUT_MS_VIEW : TIMEOUT_MS_FULL;

  const text = (pagePayload.text || "").slice(0, MAX);

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort("timeout"), TIMEOUT);

  // viewport manda busca mais “leve” (menos resultados)
  const payload = {
    task: "fake_news_classify",
    web_search: true,
    max_claims: isView ? 1 : 2,
    max_results: isView ? 3 : 6,
    page: { ...pagePayload, text }
  };

  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = API_KEY;

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`API ${resp.status}${txt ? `: ${txt}` : ""}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(to);
  }
}

// Coleta conteúdo da aba via content.js (full/viewport)
async function collectFromTab(tabId, mode = "full") {
  await exec(tabId, "content.js"); // garante injeção
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: "COLETAR_MODO", mode }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(resp || { ok: false, error: "Sem resposta do content script." });
    });
  });
}

// Mensageria usada pelo popup
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
          ? "tempo esgotado ao contatar a API."
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
  return true; // resposta assíncrona
});
