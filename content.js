// Extrai metadados úteis
function collectMeta() {
  const $ = (sel) => document.querySelector(sel);
  const meta = {};
  const ogTitle = $('meta[property="og:title"]')?.content || "";
  const ogDesc  = $('meta[property="og:description"]')?.content || "";
  const desc    = $('meta[name="description"]')?.content || "";
  const author  = $('meta[name="author"]')?.content || "";
  const pubTime = $('meta[property="article:published_time"]')?.content || "";
  meta.title = document.title || ogTitle || "";
  meta.description = ogDesc || desc || "";
  meta.author = author || "";
  meta.published_time = pubTime || "";
  return meta;
}

// Junta headings (h1..h3) para dar contexto
function collectHeadings() {
  const hs = [...document.querySelectorAll("h1, h2, h3")]
    .map(h => h.innerText.trim()).filter(Boolean);
  return { h: hs.slice(0, 20) };
}

// Limpa textos óbvios que não ajudam
function scrub(t) {
  return t.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Pega texto da página inteira
function getFullText(limit = 120000) {
  const bad = new Set(["SCRIPT","STYLE","NOSCRIPT","IFRAME","SVG","CANVAS"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || bad.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      const txt = node.nodeValue.replace(/\s+/g," ").trim();
      if (!txt) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let out = "";
  while (walker.nextNode()) {
    out += walker.currentNode.nodeValue + " ";
    if (out.length > limit) break;
  }
  return scrub(out.slice(0, limit));
}

// Pega texto apenas do que está visível na tela
function getViewportText(limit = 15000) {
  const vh = window.innerHeight, vw = window.innerWidth;
  const rectInView = (r) =>
    r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 0 && r.height > 0;

  const bad = new Set(["SCRIPT","STYLE","NOSCRIPT","IFRAME","SVG","CANVAS"]);
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || bad.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const s = getComputedStyle(p);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0)
        return NodeFilter.FILTER_REJECT;
      const r = p.getBoundingClientRect();
      if (!rectInView(r)) return NodeFilter.FILTER_REJECT;
      const txt = node.nodeValue.replace(/\s+/g," ").trim();
      if (!txt) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let out = "";
  while (walker.nextNode()) {
    nodes.push(walker.currentNode.nodeValue);
    out += walker.currentNode.nodeValue + " ";
    if (out.length > limit) break;
  }
  return scrub(out.slice(0, limit));
}

// Links de saída (úteis para a API sugerir fontes)
function collectLinks(max = 50) {
  const links = [...document.querySelectorAll("a[href]")]
    .map(a => a.href).filter(h => /^https?:/i.test(h));
  return links.slice(0, max);
}

// Recebe comando do background: full / viewport
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type !== "COLETAR_MODO") return;
    try {
      const url = location.href;
      const domain = location.hostname;
      const { title, description, author, published_time } = collectMeta();
      const headings = collectHeadings();

      let text = "";
      if ((msg.mode || "full") === "viewport") {
        text = getViewportText();
      } else {
        text = getFullText();
      }

      const payload = {
        url, domain, title,
        meta: { description },
        author, published_time,
        headings,
        links_out: collectLinks(),
        schema_org: [],
        text,
        word_count: text.split(/\s+/).length,
        capture_mode: msg.mode || "full"
      };
      sendResponse({ ok: true, payload });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
