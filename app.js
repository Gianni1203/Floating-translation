import * as pdfjsLib from "./vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;
const PDF_OPTS = {
  standardFontDataUrl: new URL("./vendor/standard_fonts/", import.meta.url).href,
};

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function toast(msg, ms = 2400) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

// ---------- settings ----------
const S = Object.assign({ model: "claude-haiku-5-5", dwell: 250, dot: true, aiUnknown: true }, store.get("hvr.settings", {}));
let API_KEY = store.get("hvr.key", "");
const saveSettings = () => store.set("hvr.settings", S);
const usage = Object.assign({ inTok: 0, outTok: 0, calls: 0 }, store.get("hvr.usage", {}));

// ---------- IndexedDB: remember last PDF ----------
const idb = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open("hvr", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async put(key, val) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch {} },
  async get(key) { try { const db = await this.open(); return await new Promise((res, rej) => { const r = db.transaction("files").objectStore("files").get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch { return null; } },
};

// ---------- dictionary ----------
let DICT = null;
fetch(new URL("./dict/ecdict-tw.json", import.meta.url)).then((r) => r.json()).then((j) => { DICT = j; }).catch(() => toast("離線字典載入失敗，請重新整理"));

function lookup(word) {
  if (!DICT) return null;
  const tries = [];
  const w = word.toLowerCase().replace(/'s$/, "");
  tries.push(w);
  if (DICT.x[w]) tries.push(DICT.x[w]);
  if (w.includes("-")) tries.push(w.replace(/-/g, ""));
  for (const [re, rep] of [[/ies$/, "y"], [/ves$/, "f"], [/es$/, ""], [/s$/, ""], [/ied$/, "y"], [/ed$/, ""], [/ed$/, "e"], [/ing$/, ""], [/ing$/, "e"], [/ly$/, ""]]) {
    if (re.test(w)) tries.push(w.replace(re, rep));
  }
  for (const t of tries) { const e = DICT.d[t]; if (e) return { head: t, phon: e[0], tr: e[1] }; }
  return null;
}

// ---------- Claude ----------
const SYS_TRANSLATE = `你是無線通訊領域的學術翻譯。把使用者提供的英文論文句子翻成台灣慣用的繁體中文。
規則：
- 只輸出譯文，不要加說明、引號或原文。
- 使用台灣學術慣用術語，例如 channel→通道、optimization→最佳化、algorithm→演算法、signal→訊號、noise→雜訊、user→使用者、beamforming→波束成形、base station→基地台、spectral efficiency→頻譜效率、achievable rate→可達速率、convex→凸、alternating optimization→交替最佳化、successive convex approximation→連續凸近似。
- 數學符號、變數與縮寫（如 MA、MIMO、CSI、SINR、RIS）保持原樣。
- 譯文要通順自然，不要逐字硬翻。`;
const SYS_EXPLAIN = `你是無線通訊領域的研究學長，用台灣繁體中文向碩士生解釋論文句子。用 2 到 4 句話說明這句在講什麼、它在論文脈絡中的作用，必要時解釋關鍵術語或數學概念的直覺意義。不要重複整句翻譯，不要使用 Markdown 標記。`;
const SYS_WORD = `你是英漢學術詞典，專長無線通訊。使用者會給一個英文詞和它所在的句子。用台灣繁體中文回答，固定兩行：
第一行：詞性縮寫和中文譯名（用台灣通訊領域慣用譯法）
第二行：在這句中的意思，20 字以內
不要輸出其他內容。`;

let inflight = null;
async function askClaude({ system, user, onText, maxTokens = 700, signal }) {
  if (!API_KEY) throw new Error("NO_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: S.model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
    if (res.status === 401) msg = "API key 無效，請到設定檢查。";
    else if (res.status === 429) msg = "請求太頻繁或超過額度，稍等一下再試。";
    else if (/credit|balance/i.test(msg)) msg = "API 額度不足，請到 Claude Console 儲值。";
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { out += ev.delta.text; onText && onText(out); }
      else if (ev.type === "message_start") usage.inTok += ev.message?.usage?.input_tokens || 0;
      else if (ev.type === "message_delta") usage.outTok += ev.usage?.output_tokens || 0;
      else if (ev.type === "error") throw new Error(ev.error?.message || "串流錯誤");
    }
  }
  usage.calls++; store.set("hvr.usage", usage);
  return out.trim();
}

const cacheGet = (k) => store.get("hvr.c." + hash(S.model + "|" + k), null);
const cacheSet = (k, v) => store.set("hvr.c." + hash(S.model + "|" + k), v);

// ---------- PDF viewer ----------
const viewer = $("viewer");
let pdfDoc = null, docKey = "", pages = [], zoom = 1, gen = 0;

function fitScale(baseW) {
  const avail = Math.min(viewer.clientWidth - 24, 1500);
  return Math.max(0.3, avail / baseW);
}

async function openPdf(data, name) {
  hideAll();
  try {
    const task = pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)), ...PDF_OPTS });
    const doc = await task.promise;
    if (pdfDoc) pdfDoc.destroy();
    pdfDoc = doc;
  } catch (e) {
    toast("無法開啟這個 PDF：" + (e.message || e));
    return;
  }
  docKey = name + ":" + data.byteLength;
  $("docName").textContent = name;
  $("empty").hidden = true;
  zoom = store.get("hvr.zoom", 1);
  const bases = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const pg = await pdfDoc.getPage(n);
    const vp = pg.getViewport({ scale: 1 });
    bases.push({ w: vp.width, h: vp.height });
  }
  pages.forEach((p) => p.div.remove());
  pages = bases.map((b, i) => makePage(i + 1, b));
  layout();
  const last = store.get("hvr.pos." + hash(docKey), null);
  if (last) requestAnimationFrame(() => scrollToFraction(last));
}

function makePage(num, base) {
  const div = el("div", "page");
  div.dataset.num = num;
  const canvas = el("canvas");
  const text = el("div", "textLayer");
  const pn = el("div", "pnum", String(num));
  div.append(canvas, text, pn);
  viewer.appendChild(div);
  const p = { num, base, div, canvas, text, rendered: false, rendering: false, index: null, scale: 1 };
  div._page = p;
  nearObs.observe(div); farObs.observe(div);
  return p;
}

function layout() {
  gen++;
  const s0 = pages.length ? fitScale(pages[0].base.w) : 1;
  for (const p of pages) {
    p.scale = s0 * zoom;
    p.div.style.width = Math.floor(p.base.w * p.scale) + "px";
    p.div.style.height = Math.floor(p.base.h * p.scale) + "px";
    unrender(p);
  }
  $("zoomFit").textContent = Math.round(zoom * 100) + "%";
  // re-trigger visible pages
  for (const p of pages) { const r = p.div.getBoundingClientRect(); if (r.bottom > -1500 && r.top < innerHeight + 1500) renderPage(p); }
}

function unrender(p) {
  p.canvas.width = 0; p.canvas.height = 0;
  p.text.replaceChildren();
  p.rendered = false; p.rendering = false; p.index = null;
}

async function renderPage(p) {
  if (p.rendered || p.rendering || !pdfDoc) return;
  p.rendering = true;
  const myGen = gen;
  try {
    const page = await pdfDoc.getPage(p.num);
    if (myGen !== gen) return;
    const vp = page.getViewport({ scale: p.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    p.canvas.width = Math.floor(vp.width * dpr);
    p.canvas.height = Math.floor(vp.height * dpr);
    const ctx = p.canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (myGen !== gen) return;
    p.div.style.setProperty("--scale-factor", vp.scale);
    p.text.replaceChildren();
    const tc = await page.getTextContent();
    if (myGen !== gen) return;
    const fontInfo = {};
    for (const [name, st] of Object.entries(tc.styles)) {
      let real = "";
      try { if (page.commonObjs.has(name)) real = page.commonObjs.get(name).name || ""; } catch {}
      fontInfo[name] = fontStyleFor(real, st.fontFamily);
      st.fontFamily = fontInfo[name].family;
    }
    const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: p.text, viewport: vp });
    await tl.render();
    if (myGen !== gen) return;
    fitSpans(tl.textDivs, tc.items, fontInfo);
    p.text.style.width = "100%"; p.text.style.height = "100%";
    p.index = null;
    p.rendered = true;
  } catch (e) {
    console.warn("render", p.num, e);
  } finally {
    if (myGen === gen) p.rendering = false;
  }
}

const nearObs = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) renderPage(e.target._page); }, { rootMargin: "1200px 0px" });
const farObs = new IntersectionObserver((ents) => { for (const e of ents) if (!e.isIntersecting) { const p = e.target._page; if (p.rendered) { unrender(p); } } }, { rootMargin: "3500px 0px" });

function currentFraction() {
  const mid = innerHeight * 0.3;
  for (const p of pages) {
    const r = p.div.getBoundingClientRect();
    if (r.bottom > mid) return { page: p.num, frac: Math.min(1, Math.max(0, (mid - r.top) / r.height)) };
  }
  return null;
}
function scrollToFraction(f) {
  const p = pages[f.page - 1]; if (!p) return;
  const r = p.div.getBoundingClientRect();
  window.scrollTo(0, window.scrollY + r.top + r.height * f.frac - innerHeight * 0.3);
}

function setZoom(z) {
  const f = currentFraction();
  zoom = Math.min(3, Math.max(0.5, Math.round(z * 20) / 20));
  store.set("hvr.zoom", zoom);
  hideAll();
  layout();
  if (f) scrollToFraction(f);
}
$("zoomIn").onclick = () => setZoom(zoom + 0.1);
$("zoomOut").onclick = () => setZoom(zoom - 0.1);
$("zoomFit").onclick = () => setZoom(1);
let gestureStart = 1;
document.addEventListener("gesturestart", (e) => { e.preventDefault(); gestureStart = zoom; });
document.addEventListener("gesturechange", (e) => e.preventDefault());
document.addEventListener("gestureend", (e) => { e.preventDefault(); if (pdfDoc && Math.abs(e.scale - 1) > 0.05) setZoom(gestureStart * e.scale); });

let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (pdfDoc) { const f = currentFraction(); layout(); if (f) scrollToFraction(f); } }, 250); });

let scrollT;
addEventListener("scroll", () => {
  if (mode === "word") hideAll();
  clearTimeout(scrollT);
  scrollT = setTimeout(() => {
    const f = currentFraction();
    if (f) { $("pageInd").textContent = `${f.page} / ${pages.length}`; store.set("hvr.pos." + hash(docKey), f); }
  }, 200);
}, { passive: true });

$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const buf = await file.arrayBuffer();
  await openPdf(buf, file.name);
  idb.put("last", { name: file.name, data: buf });
  e.target.value = "";
});


// ---------- text layer fitting ----------
// PDF.js lays the invisible text layer out with a generic font. When a paper's font is
// misclassified (e.g. NimbusRomNo9L treated as sans-serif) the letters drift from the
// rendered glyphs. Map real font names to metric-compatible system fonts instead.
const SERIF = '"Times New Roman", Times, "Nimbus Roman", "Liberation Serif", serif';
const SANS = 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif';
const MONO = '"Courier New", Courier, "Liberation Mono", monospace';
function fontStyleFor(real, generic) {
  const n = real.replace(/^[A-Z]{6}\+/, "");
  let family;
  if (/Times|NimbusRom|Nimbus ?Roman|Termes|Tinos|LiberationSerif|STIX|Georgia|Minion|Palatino|Palladio|Pagella|Utopia|Charter|^CM(R|BX|TI|SL|SS|MI|SY|EX)|^LM|SFRM|SFBX|SFTI|Computer ?Modern|Cambria|Garamond/i.test(n)) family = SERIF;
  else if (/Helvetica|Arial|NimbusSan|Heros|Arimo|LiberationSans|Calibri|Carlito|Verdana|Segoe|Roboto|OpenSans|Source ?Sans|Myriad/i.test(n)) family = SANS;
  else if (/Courier|NimbusMon|Cursor|Cousine|LiberationMono|Consolas|Menlo|^CMTT|^LMMono|SFTT/i.test(n)) family = MONO;
  else family = /mono/i.test(generic || "") ? MONO : /sans/i.test(generic || "") && !n ? SANS : SERIF;
  return {
    family,
    italic: /Ital|Oblique|Slant|^CM(TI|MI|SL)|SFTI|SFSL/i.test(n),
    bold: /Bold|Medi|Semi|Demi|Black|Heavy|^CMBX|SFBX/i.test(n),
  };
}

// Keep each span exactly as wide as the PDF says, but put justification slack into
// word spacing (where the PDF puts it) instead of stretching every letter.
function fitSpans(divs, items, fontInfo) {
  const jobs = [];
  for (let i = 0; i < divs.length; i++) {
    const d = divs[i], it = items[i];
    if (!d || !it || !it.str || !d.isConnected) continue;
    const tf = d.style.transform || "";
    if (tf && !/^scaleX\([\d.]+\)$/.test(tf.trim())) continue; // rotated text: leave as is
    jobs.push({ d, it, w: d.getBoundingClientRect().width, info: fontInfo[it.fontName] });
  }
  for (const j of jobs) {
    if (j.info?.italic) j.d.style.fontStyle = "italic";
    if (j.info?.bold) j.d.style.fontWeight = "bold";
    j.d.style.transform = "none";
  }
  for (const j of jobs) j.n = j.d.getBoundingClientRect().width;
  for (const j of jobs) {
    if (!j.n || !j.w) continue;
    const spaces = (j.it.str.match(/ /g) || []).length;
    const slack = j.w - j.n;
    if (spaces > 0 && slack > 0 && slack / spaces < j.n / Math.max(1, j.it.str.length) * 3) {
      j.d.style.wordSpacing = (slack / spaces) + "px";
    } else {
      j.d.style.transform = `scaleX(${j.w / j.n})`;
    }
  }
}

// ---------- text index per page ----------
function getIndex(p) {
  if (p.index) return p.index;
  const spans = [...p.text.querySelectorAll("span")].filter((s) => !s.classList.contains("markedContent") && s.firstChild && s.firstChild.nodeType === 3);
  let text = "";
  const nodes = [], map = new Map();
  let prev = null;
  for (const s of spans) {
    const t = s.firstChild.data;
    if (!t) continue;
    const r = s.getBoundingClientRect();
    if (prev) {
      const h = Math.max(1, Math.min(r.height, prev.r.height));
      const sameLine = Math.abs((r.top + r.bottom) / 2 - (prev.r.top + prev.r.bottom) / 2) < h * 0.5;
      let sep = "";
      if (sameLine) {
        if (r.left - prev.r.right > h * 0.15 && !/\s$/.test(prev.t) && !/^\s/.test(t)) sep = " ";
      } else {
        const gap = r.top - prev.r.bottom;
        if (gap > h * 0.9) sep = "\u0003";                       // paragraph break
        else if (/[A-Za-z]-$/.test(prev.t) && /^[a-z]/.test(t)) sep = "\u0002"; // hyphenated line break
        else if (!/\s$/.test(prev.t)) sep = " ";
      }
      text += sep;
    }
    const n = { node: s.firstChild, start: text.length };
    nodes.push(n); map.set(s.firstChild, n);
    text += t;
    prev = { r, t };
  }
  p.index = { text, nodes, map };
  return p.index;
}

function posToDom(idx, g) {
  let lo = 0, hi = idx.nodes.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.nodes[mid].start <= g) lo = mid; else hi = mid - 1; }
  const n = idx.nodes[lo];
  return { node: n.node, offset: Math.min(Math.max(0, g - n.start), n.node.length) };
}
function makeRange(idx, s, e) {
  const a = posToDom(idx, s), b = posToDom(idx, e);
  const r = document.createRange();
  r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
  return r;
}
const cleanText = (t) => t.replace(/-\u0002/g, "").replace(/[\u0002\u0003]/g, " ").replace(/\s+/g, " ").trim();

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const c = document.caretPositionFromPoint(x, y);
    if (c && c.offsetNode) return { node: c.offsetNode, offset: c.offset };
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

const isW = (ch) => !!ch && /[A-Za-z0-9\-'\u0002]/.test(ch);
function hitWord(x, y) {
  const c = caretAt(x, y);
  if (!c || c.node.nodeType !== 3) return null;
  const tl = c.node.parentElement && c.node.parentElement.closest(".textLayer");
  if (!tl) return null;
  const p = tl.parentElement._page;
  if (!p || !p.rendered) return null;
  const idx = getIndex(p);
  const n = idx.map.get(c.node);
  if (!n) return null;
  const T = idx.text;
  let k = n.start + c.offset;
  if (!isW(T[k])) k--;
  if (k < 0 || !isW(T[k])) return null;
  let s = k, e = k + 1;
  while (s > 0 && isW(T[s - 1])) s--;
  while (e < T.length && isW(T[e])) e++;
  while (s < e && /['\-]/.test(T[s])) s++;
  while (e > s && /['\-\u0002]/.test(T[e - 1])) e--;
  if (e <= s) return null;
  const word = cleanText(T.slice(s, e));
  if (!/[A-Za-z]/.test(word)) return null;
  const range = makeRange(idx, s, e);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const pad = 6;
  if (!rects.some((r) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad)) return null;
  return { p, idx, s, e, word, rects, key: p.num + ":" + s };
}

const ABBR = /(?:\b(?:e\.g|i\.e|et al|etc|Fig|Figs|Eq|Eqs|Sec|Ref|Refs|vs|cf|resp|No|Thm|Lem|Prop|Def|Alg|Ch|Tab|approx|w\.r\.t|s\.t|Mr|Dr|Prof|pp|Vol)|\b[A-Z]\.[A-Z])$/;
function sentenceAt(idx, g) {
  const T = idx.text;
  const isEnd = (i) => {
    const ch = T[i];
    if (!/[.?!]/.test(ch)) return false;
    const nx = T[i + 1];
    if (nx === undefined) return true;
    if (!/[\s\u0002\u0003"”')\]]/.test(nx)) return false;
    if (ch === "." && ABBR.test(T.slice(Math.max(0, i - 12), i))) return false;
    return true;
  };
  let s = g;
  while (s > 0 && T[s - 1] !== "\u0003" && !isEnd(s - 1) && g - s < 1200) s--;
  let e = g;
  while (e < T.length && T[e] !== "\u0003" && e - g < 1200) { if (isEnd(e)) { e++; break; } e++; }
  while (s < e && /[\s\u0002\u0003]/.test(T[s])) s++;
  while (e > s && /[\s\u0002\u0003]/.test(T[e - 1])) e--;
  return { s, e };
}

// ---------- overlay & bubble ----------
const overlay = $("overlay"), bubble = $("bubble"), tipDot = $("tipDot");
let mode = null, shownKey = null, showTimer = null, hideTimer = null, pendingKey = null, lastX = 0, lastY = 0;

function drawRects(rects, cls) {
  for (const r of rects) {
    const d = el("div", "hl " + cls);
    d.style.left = (r.left + scrollX - 1) + "px";
    d.style.top = (cls === "cand" ? r.bottom + scrollY : r.top + scrollY - 1) + "px";
    d.style.width = (r.width + 2) + "px";
    d.style.height = (r.height + 2) + "px";
    overlay.appendChild(d);
  }
}
function clearOverlay(cls) { overlay.querySelectorAll(cls ? ".hl." + cls : ".hl").forEach((n) => n.remove()); }

let anchorRect = null;
function placeBubble(rect) {
  anchorRect = rect || anchorRect;
  if (!anchorRect) return;
  bubble.hidden = false;
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  let left = anchorRect.left + anchorRect.width / 2 - bw / 2;
  left = Math.max(12, Math.min(left, innerWidth - bw - 12));
  const barH = $("bar").offsetHeight;
  let top = anchorRect.top - bh - 10;
  if (top < barH + 8) top = anchorRect.bottom + 10;
  bubble.style.left = (left + scrollX) + "px";
  bubble.style.top = (top + scrollY) + "px";
}

function hideAll() {
  mode = null; shownKey = null; pendingKey = null;
  clearTimeout(showTimer); clearTimeout(hideTimer);
  if (inflight) { inflight.abort(); inflight = null; }
  clearOverlay();
  bubble.hidden = true; bubble.classList.remove("interactive");
}

function unionRect(rects) {
  const l = Math.min(...rects.map((r) => r.left)), t = Math.min(...rects.map((r) => r.top));
  const rr = Math.max(...rects.map((r) => r.right)), b = Math.max(...rects.map((r) => r.bottom));
  return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t };
}

// ----- word -----
function showWord(hit) {
  if (inflight) { inflight.abort(); inflight = null; }
  mode = "word"; shownKey = hit.key;
  clearOverlay(); drawRects(hit.rects, "word");
  bubble.classList.remove("interactive");
  bubble.replaceChildren();
  const head = el("div");
  const entry = lookup(hit.word);
  head.appendChild(el("span", "w", hit.word));
  if (entry && entry.phon) head.appendChild(el("span", "ph", "/" + entry.phon + "/"));
  bubble.appendChild(head);
  const tr = el("div", "tr");
  bubble.appendChild(tr);
  if (entry) {
    if (entry.head !== hit.word.toLowerCase()) tr.appendChild(el("div", "ai", "原形：" + entry.head));
    entry.tr.split("\n").forEach((line) => tr.appendChild(el("div", null, line)));
    placeBubble(unionRect(hit.rects));
    return;
  }
  if (!DICT) { tr.textContent = "字典載入中…"; placeBubble(unionRect(hit.rects)); return; }
  if (!S.aiUnknown || !API_KEY) { tr.textContent = API_KEY ? "字典裡沒有這個詞" : "字典裡沒有這個詞（設定 API key 後可自動問 Claude）"; placeBubble(unionRect(hit.rects)); return; }
  const sent = sentenceAt(hit.idx, hit.s);
  const sentence = cleanText(hit.idx.text.slice(sent.s, sent.e));
  const ck = "w|" + hit.word.toLowerCase() + "|" + hash(sentence);
  const cached = cacheGet(ck);
  const render = (t, live) => { tr.replaceChildren(); t.split("\n").filter(Boolean).forEach((l) => tr.appendChild(el("div", null, l))); if (live) tr.lastChild?.classList.add("cursor"); tr.appendChild(el("div", "ai", "字典沒有，由 Claude 依上下文解釋")); placeBubble(); };
  placeBubble(unionRect(hit.rects));
  if (cached) { render(cached); return; }
  tr.appendChild(el("div", "cursor", "詢問 Claude"));
  placeBubble();
  const ac = new AbortController(); inflight = ac;
  const myKey = hit.key;
  askClaude({ system: SYS_WORD, user: `詞：${hit.word}\n句子：${sentence}`, maxTokens: 120, signal: ac.signal, onText: (t) => { if (shownKey === myKey) render(t, true); } })
    .then((t) => { cacheSet(ck, t); if (shownKey === myKey) render(t); })
    .catch((e) => { if (e.name !== "AbortError" && shownKey === myKey) { tr.replaceChildren(el("div", "err", e.message)); placeBubble(); } })
    .finally(() => { if (inflight === ac) inflight = null; });
}

// ----- sentence -----
function showSentence(hit) {
  if (inflight) { inflight.abort(); inflight = null; }
  clearTimeout(showTimer); clearTimeout(hideTimer); pendingKey = null;
  const { s, e } = sentenceAt(hit.idx, hit.s);
  const sentence = cleanText(hit.idx.text.slice(s, e));
  if (!sentence) return;
  mode = "sent"; shownKey = "s" + hit.p.num + ":" + s;
  const myKey = shownKey;
  clearOverlay();
  const rects = [...makeRange(hit.idx, s, e).getClientRects()].filter((r) => r.width > 1);
  drawRects(rects, "sent");
  bubble.classList.add("interactive");
  bubble.replaceChildren();
  bubble.appendChild(el("div", "label", "整句翻譯"));
  const body = el("div", "tr");
  bubble.appendChild(body);
  const tools = el("div", "tools");
  const anchor = rects.length ? rects[rects.length - 1] : unionRect(hit.rects);
  placeBubble(anchor);

  if (!API_KEY) {
    body.textContent = "還沒設定 Claude API key，所以無法翻譯整句。";
    const b = el("button", "btn small", "開啟設定"); b.type = "button"; b.onclick = () => { hideAll(); openSettings(); };
    tools.appendChild(b); bubble.appendChild(tools); placeBubble();
    return;
  }

  const ctxStart = Math.max(0, s - 500);
  const context = cleanText(hit.idx.text.slice(ctxStart, s)).slice(-400);
  const ck = "s|" + sentence;
  const explainBtn = el("button", "btn small", "解釋這句"); explainBtn.type = "button";
  const copyBtn = el("button", "btn small", "複製譯文"); copyBtn.type = "button";
  let finalText = "";
  copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(finalText); toast("已複製譯文"); } catch { toast("無法複製"); } };
  explainBtn.onclick = () => {
    explainBtn.disabled = true;
    const box = el("div", "explain cursor", "");
    bubble.insertBefore(box, tools); placeBubble();
    const ek = "e|" + sentence;
    const c = cacheGet(ek);
    if (c) { box.textContent = c; box.classList.remove("cursor"); placeBubble(); return; }
    const ac = new AbortController(); inflight = ac;
    askClaude({ system: SYS_EXPLAIN, user: `前文：${context}\n\n句子：${sentence}`, maxTokens: 500, signal: ac.signal, onText: (t) => { if (shownKey === myKey) { box.textContent = t; placeBubble(); } } })
      .then((t) => { cacheSet(ek, t); box.classList.remove("cursor"); box.textContent = t; placeBubble(); })
      .catch((err) => { if (err.name !== "AbortError") { box.classList.remove("cursor"); box.replaceChildren(el("span", "err", err.message)); explainBtn.disabled = false; placeBubble(); } })
      .finally(() => { if (inflight === ac) inflight = null; });
  };
  tools.append(explainBtn, copyBtn);

  const done = (t) => { finalText = t; body.classList.remove("cursor"); body.textContent = t; if (!tools.isConnected) bubble.appendChild(tools); placeBubble(); };
  const cached = cacheGet(ck);
  if (cached) { done(cached); return; }
  body.classList.add("cursor"); body.textContent = "";
  const ac = new AbortController(); inflight = ac;
  askClaude({
    system: SYS_TRANSLATE,
    user: (context ? `前文（僅供理解，不要翻譯）：\n${context}\n\n` : "") + `要翻譯的句子：\n${sentence}`,
    signal: ac.signal,
    onText: (t) => { if (shownKey === myKey) { body.textContent = t; placeBubble(); } },
  })
    .then((t) => { cacheSet(ck, t); if (shownKey === myKey) done(t); })
    .catch((err) => { if (err.name !== "AbortError" && shownKey === myKey) { body.classList.remove("cursor"); body.replaceChildren(el("span", "err", err.message)); placeBubble(); } })
    .finally(() => { if (inflight === ac) inflight = null; });
}

// ---------- pointer handling ----------
function showCand(hit) {
  clearOverlay("cand");
  if (hit && hit.key !== shownKey) drawRects(hit.rects, "cand");
}

function onHover(x, y, isPen) {
  lastX = x; lastY = y;
  if (isPen && S.dot) { tipDot.hidden = false; tipDot.style.transform = `translate(${x}px, ${y}px)`; }
  if (mode === "sent") return;
  const hit = hitWord(x, y);
  showCand(hit);
  if (!hit) {
    clearTimeout(showTimer); pendingKey = null;
    if (mode === "word") { clearTimeout(hideTimer); hideTimer = setTimeout(hideAll, 700); }
    return;
  }
  clearTimeout(hideTimer);
  if (hit.key === shownKey) { clearTimeout(showTimer); pendingKey = null; return; }
  if (hit.key === pendingKey) return;
  pendingKey = hit.key;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    const h = hitWord(lastX, lastY);
    if (h && h.key === pendingKey) { clearOverlay("cand"); showWord(h); }
    pendingKey = null;
  }, S.dwell);
}

const inUI = (t) => t instanceof Element && !!t.closest(".bar, dialog, #bubble");

document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" || e.buttons !== 0) return;
  if (inUI(e.target)) { tipDot.hidden = true; return; }
  onHover(e.clientX, e.clientY, e.pointerType === "pen");
}, { passive: true });

document.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") return;
  if (inUI(e.target)) return;
  const hit = hitWord(e.clientX, e.clientY);
  if (hit) showSentence(hit);
  else if (mode) hideAll();
});

document.addEventListener("pointerout", (e) => {
  if (e.pointerType === "pen" && !e.relatedTarget) { tipDot.hidden = true; clearOverlay("cand"); clearTimeout(showTimer); pendingKey = null; }
});

// ---------- settings dialog ----------
const dlg = $("settings");
function renderUsage() {
  $("usage").textContent = usage.calls
    ? `${usage.calls} 次請求 · 輸入 ${usage.inTok.toLocaleString()} tokens · 輸出 ${usage.outTok.toLocaleString()} tokens`
    : "尚無紀錄";
}
function openSettings() {
  $("apiKey").value = API_KEY;
  $("model").value = S.model;
  $("dwell").value = S.dwell; $("dwellOut").textContent = S.dwell + " ms";
  $("showDot").checked = S.dot;
  $("aiUnknown").checked = S.aiUnknown;
  $("testStatus").textContent = ""; $("testStatus").className = "status";
  renderUsage();
  dlg.showModal();
}
$("settingsBtn").onclick = openSettings;
$("apiKey").addEventListener("change", () => { API_KEY = $("apiKey").value.trim(); store.set("hvr.key", API_KEY); updateHint(); });
$("toggleKey").onclick = () => { const i = $("apiKey"); const show = i.type === "password"; i.type = show ? "text" : "password"; $("toggleKey").textContent = show ? "隱藏" : "顯示"; };
$("model").onchange = () => { S.model = $("model").value; saveSettings(); };
$("dwell").oninput = () => { S.dwell = +$("dwell").value; $("dwellOut").textContent = S.dwell + " ms"; saveSettings(); };
$("showDot").onchange = () => { S.dot = $("showDot").checked; if (!S.dot) tipDot.hidden = true; saveSettings(); };
$("aiUnknown").onchange = () => { S.aiUnknown = $("aiUnknown").checked; saveSettings(); };
$("resetUsage").onclick = () => { usage.inTok = usage.outTok = usage.calls = 0; store.set("hvr.usage", usage); renderUsage(); };
$("clearCache").onclick = () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith("hvr.c.")).forEach((k) => localStorage.removeItem(k)); } catch {}
  toast("已清除翻譯快取");
};
$("testKey").onclick = async () => {
  API_KEY = $("apiKey").value.trim(); store.set("hvr.key", API_KEY); updateHint();
  const st = $("testStatus");
  st.className = "status"; st.textContent = "連線中…";
  try {
    const t = await askClaude({ system: SYS_TRANSLATE, user: "要翻譯的句子：\nThe channel state information is assumed to be perfectly known.", maxTokens: 80 });
    st.className = "status ok"; st.textContent = "成功：" + t;
    renderUsage();
  } catch (e) {
    st.className = "status bad"; st.textContent = e.message === "NO_KEY" ? "請先填入 API key" : e.message;
  }
};
dlg.addEventListener("close", () => { API_KEY = $("apiKey").value.trim(); store.set("hvr.key", API_KEY); updateHint(); });

function updateHint() {
  $("emptyHint").textContent = API_KEY
    ? "已設定 Claude API key。單字查詢使用離線字典，整句翻譯會呼叫 Claude。"
    : "整句翻譯需要先到「設定」填入 Claude API key；單字查詢使用離線字典，不需要網路。";
}
updateHint();

// ---------- restore last PDF ----------
(async () => {
  const last = await idb.get("last");
  if (last && last.data) await openPdf(last.data, last.name);
})();
