"use strict";
/* ============================================================
   青空リーダー（Webアプリ版）
   ・目録と本文は青空文庫がGitHubで公開しているデータを直接取得
   ・目録と読んだ本文は IndexedDB に保存（オフラインでも読める）
   ・AIはユーザー自身のAPIキーで各社APIを直接呼ぶ
   ============================================================ */

const REPO = [
  "https://raw.githubusercontent.com/aozorabunko/aozorabunko/master/",
  "https://cdn.jsdelivr.net/gh/aozorabunko/aozorabunko@master/",
];
const CATALOG_PATH = "index_pages/list_person_all_extended_utf8.zip";
const CATALOG_TTL = 7 * 24 * 3600 * 1000;

async function fetchRepo(path) {
  let last;
  for (const base of REPO) {
    try {
      const r = await fetch(base + path);
      if (r.ok) return { buf: await r.arrayBuffer(), base };
      last = new Error("HTTP " + r.status);
    } catch (e) { last = e; }
  }
  throw new Error("青空文庫のデータを取得できませんでした。通信状況を確かめて、もう一度お試しください。" + (last ? `（${last.message}）` : ""));
}

/* ---------- IndexedDB（小さなキー・値ストア） ---------- */
const idb = {
  _db: null,
  open() {
    return this._db ||= new Promise((res, rej) => {
      const q = indexedDB.open("aozora-reader", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("kv");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  async get(k) {
    try { const db = await this.open(); return await new Promise(res => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
    catch (e) { return undefined; }
  },
  async set(k, v) {
    try { const db = await this.open(); return await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); }
    catch (e) { return false; }
  },
  async del(k) {
    try { const db = await this.open(); return await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); }
    catch (e) { return false; }
  },
  async clear() {
    try { const db = await this.open(); return await new Promise(res => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").clear(); t.oncomplete = () => res(true); }); }
    catch (e) { return false; }
  },
};

/* ---------- 設定・本棚など（localStorage） ---------- */
const KEY = "aozora-reader-pwa-v1";
const defaults = () => ({
  shelf: {}, phrases: [], tags: [], recs: null, ai: {}, downloaded: {},
  reader: { vertical: true, size: 19, lh: 1.9, theme: "paper", font: "mincho" },
  aiProvider: "anthropic", aiKeys: {}, aiModels: {}, ciniiAppId: "",
});
let S = defaults();
try { const raw = localStorage.getItem(KEY); if (raw) S = Object.assign(defaults(), JSON.parse(raw)); } catch (e) {}
let saveWarned = false;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { if (!saveWarned) { saveWarned = true; toast("この端末に保存できませんでした。プライベートブラウズでは記録が残りません"); } }
}

/* ============================================================
   ユーティリティ
   ============================================================ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function norm(s) {
  return String(s || "").replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/龍/g, "竜").replace(/鷗/g, "鴎").replace(/澤/g, "沢").replace(/國/g, "国")
    .replace(/[\s・　]/g, "").toLowerCase();
}
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2400); }
const STATUS = { want: "読みたい", reading: "読んでいる", finished: "読んだ" };
function ensureShelf(w, status = "want") {
  if (!S.shelf[w.id]) S.shelf[w.id] = { status, progress: 0, rating: 0, added: Date.now(), opened: 0, t: w.t, a: w.a };
  return S.shelf[w.id];
}

/* NDC 分類 → ジャンル名 */
function ndcCode(ndc) { return (String(ndc).split(" ").pop() || "").replace(/\D/g, ""); }
function ndcLabel(code) {
  const m = { "913": "小説・物語", "914": "随筆", "911": "詩歌", "912": "戯曲", "915": "日記・書簡・紀行", "916": "記録", "918": "作品集", "910": "日本文学" };
  if (m[code]) return m[code];
  if (/^9[2-9]3$/.test(code)) return "翻訳文学";
  return ({ "0": "総記", "1": "哲学・宗教", "2": "歴史・地理", "3": "社会科学", "4": "自然科学", "5": "技術", "6": "産業", "7": "芸術", "8": "言語", "9": "文学" })[code[0]] || "その他";
}

/* 好みタグ → 作家（候補集め用） */
const ALL_TAGS = ["短く読める", "ミステリ・怪奇", "幻想・SF", "恋愛", "家族・人生", "ユーモア", "童話", "詩・短歌", "随筆", "思想・評論", "歴史もの", "旅・紀行"];
const TAG_AUTHORS = {
  "短く読める": ["梶井基次郎", "新美南吉", "中島敦", "芥川竜之介"],
  "ミステリ・怪奇": ["江戸川乱歩", "夢野久作", "岡本綺堂", "海野十三", "久生十蘭", "泉鏡花"],
  "幻想・SF": ["海野十三", "泉鏡花", "宮沢賢治", "夢野久作", "稲垣足穂"],
  "恋愛": ["樋口一葉", "堀辰雄", "伊藤左千夫", "岡本かの子", "林芙美子"],
  "家族・人生": ["島崎藤村", "国木田独歩", "林芙美子", "織田作之助", "太宰治"],
  "ユーモア": ["夏目漱石", "坂口安吾", "織田作之助", "牧野信一"],
  "童話": ["宮沢賢治", "新美南吉", "小川未明", "鈴木三重吉"],
  "詩・短歌": ["中原中也", "萩原朔太郎", "石川啄木", "与謝野晶子", "正岡子規", "八木重吉"],
  "随筆": ["寺田寅彦", "正岡子規", "中谷宇吉郎", "岡本かの子"],
  "思想・評論": ["坂口安吾", "和辻哲郎", "三木清", "戸坂潤", "折口信夫"],
  "歴史もの": ["森鴎外", "芥川竜之介", "岡本綺堂", "中島敦", "吉川英治"],
  "旅・紀行": ["正岡子規", "寺田寅彦", "林芙美子", "田山花袋"],
};
const TAG_NDC = { "詩・短歌": "911", "随筆": "914", "旅・紀行": "915" };
const CLASSIC_AUTHORS = ["夏目漱石", "芥川竜之介", "太宰治", "宮沢賢治", "森鴎外", "中島敦", "梶井基次郎", "坂口安吾", "樋口一葉", "泉鏡花",
  "江戸川乱歩", "夢野久作", "新美南吉", "小川未明", "寺田寅彦", "中原中也", "萩原朔太郎", "正岡子規", "岡本綺堂", "織田作之助",
  "堀辰雄", "島崎藤村", "国木田独歩", "横光利一", "海野十三", "与謝野晶子", "石川啄木", "林芙美子", "岡本かの子", "久生十蘭"];

/* ============================================================
   目録
   ============================================================ */
let CAT = [], BY_ID = {}, BY_AUTHOR = {}, KEYS = [];
let catState = { status: "idle", msg: "" };

function parseCSV(text, onRow) {
  let row = [], field = "", q = false;
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); onRow(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); onRow(row); }
}
function parseCatalog(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let H = null; const seen = new Set(), out = [];
  parseCSV(text, r => {
    if (!H) { H = {}; r.forEach((h, i) => H[h.trim()] = i); return; }
    const c = (...names) => { for (const n of names) if (H[n] !== undefined && r[H[n]] !== undefined) return r[H[n]]; return ""; };
    const role = c("役割フラグ");
    if (role && role !== "著者") return;
    const id = c("作品ID"); if (!id || seen.has(id)) return;
    const html = c("XHTML/HTMLファイルURL");
    if (!/aozora\.gr\.jp\/cards\//.test(html)) return;
    seen.add(id);
    out.push({
      id, t: c("作品名"), ty: c("作品名読み"), st: c("副題"),
      aid: c("人物ID"), a: c("姓") + c("名"), ay: c("姓読み") + c("名読み"),
      ndc: ndcCode(c("分類番号")), kana: c("文字遣い種別"), first: c("初出"), pub: c("公開日"),
      card: c("図書カードURL"), html: html.replace(/^https?:\/\/www\.aozora\.gr\.jp\//, ""),
    });
  });
  return out;
}
function applyCatalog(list) {
  CAT = list; BY_ID = {}; BY_AUTHOR = {};
  for (const w of list) { BY_ID[w.id] = w; (BY_AUTHOR[w.aid] ||= []).push(w); }
  KEYS = list.map(w => [norm(w.t), norm(w.ty), norm(w.a), norm(w.ay)]);
}
async function loadCatalog(force = false) {
  if (catState.status === "loading") return;
  catState = { status: "loading", msg: "目録を読み込み中…" }; refreshBanner();
  let cached = await idb.get("catalog");
  if (force || !cached || Date.now() - cached.at > CATALOG_TTL) {
    try {
      catState.msg = cached ? "目録を更新中…" : "青空文庫の目録をダウンロード中…（初回のみ・数MB）"; refreshBanner();
      if (!window.JSZip) throw new Error("zipを開く部品を読み込めませんでした");
      const { buf } = await fetchRepo(CATALOG_PATH);
      const zip = await JSZip.loadAsync(buf);
      const entry = Object.values(zip.files).find(f => /\.csv$/i.test(f.name));
      if (!entry) throw new Error("目録ファイルが見つかりません");
      const works = parseCatalog(await entry.async("string"));
      if (works.length < 100) throw new Error("目録の形式を読み取れませんでした");
      cached = { at: Date.now(), works };
      await idb.set("catalog", cached);
    } catch (e) {
      if (!cached) { catState = { status: "error", msg: e.message }; refreshBanner(); render(); return; }
      toast("目録を更新できなかったため、保存済みの目録を使います");
    }
  }
  applyCatalog(cached.works);
  catState = { status: "ready", msg: "", at: cached.at };
  refreshBanner(); render();
}
function search(q, limit = 120) {
  q = norm(q); if (!q) return [];
  const hits = [];
  for (let i = 0; i < CAT.length; i++) {
    const [t, ty, a, ay] = KEYS[i]; let s = 0;
    if (t === q || ty === q) s = 100;
    else if (t.startsWith(q) || ty.startsWith(q)) s = 80;
    else if (t.includes(q) || ty.includes(q)) s = 60;
    else if (a === q || ay === q) s = 50;
    else if (a.includes(q) || ay.includes(q)) s = 40;
    if (s) hits.push([s, CAT[i]]);
  }
  return hits.sort((x, y) => y[0] - x[0] || (x[1].ty < y[1].ty ? -1 : 1)).slice(0, limit).map(h => h[1]);
}
const authorIdByName = name => (CAT.find(w => w.a === name) || {}).aid;
function workOf(id) { return BY_ID[id] || (S.shelf[id] && { id, t: S.shelf[id].t, a: S.shelf[id].a, aid: "", ndc: "", kana: "", html: S.shelf[id].html || "" }) || null; }

/* ============================================================
   本文の取得と整形
   ============================================================ */
const KANJI = "[々〆ヵヶ\\u3400-\\u9FFF\\uF900-\\uFAFF\\u{20000}-\\u{2FFFF}]";
function gaiji(desc) {
  const u = desc.match(/U\+([0-9A-Fa-f]{4,5})/);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  return "〓";
}
/* HTMLのDOM → 青空文庫テキスト形式（ルビ・傍点・字下げ・外字画像を保つ） */
function walkAozora(n, base) {
  if (n.nodeType === 3) return n.nodeValue.replace(/\n/g, "");
  if (n.nodeType !== 1 && n.nodeType !== 11) return "";
  const tag = n.nodeType === 11 ? "#frag" : n.tagName.toLowerCase();
  const kids = () => [...n.childNodes].map(c => walkAozora(c, base)).join("");
  if (tag === "br") return "\n";
  if (/^(rt|rp|script|style|head|title|meta)$/.test(tag)) return "";
  if (tag === "ruby") {
    const rb = [...n.childNodes].filter(c => !(c.tagName && /^(rt|rp)$/i.test(c.tagName))).map(c => walkAozora(c, base)).join("");
    const rt = n.querySelector("rt");
    return rt ? `｜${rb}《${rt.textContent.trim()}》` : rb;
  }
  if (tag === "img") {
    const alt = n.getAttribute("alt") || "", src = n.getAttribute("src") || "";
    const u = alt.match(/U\+([0-9A-Fa-f]{4,5})/);
    if (u) return String.fromCodePoint(parseInt(u[1], 16));
    if (src && base) { try { return `［＃外字画像:${new URL(src, base).href}］`; } catch (e) {} }
    return alt ? "〓" : "";
  }
  if (tag === "em" && /sesame_dot/.test(n.className)) { const t = kids(); return t + `［＃「${t.replace(/｜|《.*?》|［＃.*?］/g, "")}」に傍点］`; }
  const inner = kids();
  if (tag === "div" || tag === "p" || tag === "li") {
    const m = (n.className || "").match(/jisage_(\d+)/);
    return "\n" + (m ? inner.split("\n").map(l => l ? `［＃${m[1]}字下げ］` + l : l).join("\n") : inner) + "\n";
  }
  if (/^h[1-6]$/.test(tag)) return `\n${inner}［＃「${inner}」は中見出し］\n`;
  return inner;
}
function decodeBytes(u8) {
  const head = new TextDecoder("ascii").decode(u8.slice(0, 1024)).toLowerCase();
  if (/charset=["']?utf-8/.test(head)) return new TextDecoder("utf-8").decode(u8);
  if (/euc-jp/.test(head)) return new TextDecoder("euc-jp").decode(u8);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch (e) { return new TextDecoder("shift_jis").decode(u8); }
}
function parseAozoraHTML(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const main = doc.querySelector(".main_text");
  if (!main) throw new Error("本文が見つかりませんでした");
  return walkAozora(main, base).replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
}
async function loadText(w) {
  const cached = await idb.get("text:" + w.id);
  if (cached) return cached;
  if (!w.html) throw new Error("この作品の本文ファイルの場所が分かりません");
  const { buf, base } = await fetchRepo(w.html);
  const src = parseAozoraHTML(decodeBytes(new Uint8Array(buf)), base + w.html);
  const t = { src, at: Date.now() };
  await idb.set("text:" + w.id, t);
  S.downloaded[w.id] = Date.now(); save();
  return t;
}

/* 青空文庫テキスト形式 → 表示用HTML */
function aozoraToHTML(src) {
  let indentBlock = 0; const out = [];
  for (let line of src.replace(/\r/g, "").split("\n")) {
    let cls = "", style = "", m;
    if ((m = line.match(/^［＃ここから(\d+)字下げ.*?］$/))) { indentBlock = +m[1]; continue; }
    if (/^［＃ここで字下げ終わり］$/.test(line)) { indentBlock = 0; continue; }
    if (/［＃改(ページ|丁|段|見開き)］/.test(line)) { out.push('<hr class="pb">'); continue; }
    let indent = indentBlock;
    if ((m = line.match(/^［＃(\d+)字下げ］/))) { indent = +m[1]; line = line.slice(m[0].length); }
    if (/［＃「.+?」は(大|中|小)見出し］/.test(line)) cls = "h";
    if (/［＃地付き］/.test(line)) style += "text-align:end;";
    const imgs = [];
    line = line.replace(/［＃外字画像:(.+?)］/g, (_, u) => { imgs.push(u); return String.fromCharCode(0xE000 + imgs.length - 1); });
    line = line.replace(/※［＃(.+?)］/g, (_, d) => gaiji(d));
    line = line.replace(/([^［]*)［＃「(.+?)」に(白ゴマ)?傍点］/g, (all, before, target) => {
      const i = before.lastIndexOf(target);
      return i < 0 ? before : before.slice(0, i) + "\u0001" + target + "\u0002" + before.slice(i + target.length);
    });
    line = line.replace(/［＃.*?］/g, "");
    let h = esc(line).replace(/\u0001/g, '<em class="dot">').replace(/\u0002/g, "</em>");
    h = h.replace(/｜([^《｜]+?)《(.+?)》/g, "<ruby>$1<rt>$2</rt></ruby>");
    h = h.replace(new RegExp(`(${KANJI}+)《(.+?)》`, "gu"), "<ruby>$1<rt>$2</rt></ruby>");
    h = h.replace(/《(.+?)》/g, "");
    h = h.replace(/(?<![0-9０-９])([0-9]{1,2})(?![0-9０-９])/g, '<span class="tcy">$1</span>');
    if (imgs.length) h = h.replace(/[\uE000-\uE0FF]/g, c => `<img class="gaiji" src="${esc(imgs[c.charCodeAt(0) - 0xE000] || "")}" alt="※">`);
    if (indent) style += `padding-inline-start:${indent}em;`;
    if (!h.trim()) out.push('<p class="blank">　</p>');
    else out.push(`<p${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""}>${h}</p>`);
  }
  return out.join("");
}
function aozoraToPlain(src) {
  return src.replace(/［＃外字画像:.+?］/g, "※").replace(/※［＃(.+?)］/g, (_, d) => gaiji(d))
    .replace(/［＃.*?］/g, "").replace(/《.+?》/g, "").replace(/｜/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* 貼り付け（目録にない作品や、取得できないときの予備） */
function parsePasted(html, text) {
  let title = "", author = "", src = "";
  if (html && /<ruby|class="?(main_text|title|author)/i.test(html)) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    title = doc.querySelector(".title")?.textContent.trim() || "";
    author = doc.querySelector(".author")?.textContent.trim() || "";
    const root = doc.querySelector(".main_text") || doc.body;
    root.querySelectorAll(".metadata, .bibliographical_information, .notation_notes, .after_text, h1.title, h2.subtitle, h2.author, h2.translator").forEach(x => x.remove());
    src = walkAozora(root, null);
  } else {
    src = (text || "").replace(new RegExp(`(${KANJI}+)（([ぁ-ゖァ-ヺー・]+)）`, "gu"), "｜$1《$2》");
  }
  src = src.replace(/\r/g, "");
  const cut = src.search(/^\s*(底本：|［＃本文終わり］)/m);
  if (cut > 0) src = src.slice(0, cut);
  const lines = src.split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  const pl = l => l.replace(/｜|《.*?》|［＃.*?］/g, "").trim();
  if (!title && lines.length > 3 && pl(lines[0]).length <= 40 && !/[。、]/.test(lines[0])) {
    title = pl(lines.shift());
    if (lines.length && pl(lines[0]) && pl(lines[0]).length <= 20 && !/[。、]/.test(lines[0])) author = pl(lines.shift());
  } else {
    while (lines.length && (pl(lines[0]) === title || pl(lines[0]) === author || !lines[0].trim())) lines.shift();
  }
  return { title, author, src: lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "") };
}

/* ============================================================
   AI（ユーザー自身のAPIキー）
   ============================================================ */
const PROVIDERS = {
  anthropic: { label: "Anthropic（Claude）", model: "claude-sonnet-5-5", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI（GPT）", model: "gpt-5-mini", keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { label: "Google（Gemini）", model: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
};
const aiReady = () => !!(S.aiKeys[S.aiProvider] || "").trim();
const aiModel = () => (S.aiModels[S.aiProvider] || "").trim() || PROVIDERS[S.aiProvider].model;
const AI_BASE = "あなたは日本近代文学に精通した、親切な読書案内人です。青空文庫で古典・近代文学を読む現代の読者を助けます。日本語で、平易かつ正確に答えてください。確証のない事実（成立年、初出誌、逸話、研究者名や論文名など）は断定せず「〜とされる」「要確認」と明記してください。作品の引用は短くとどめてください。";

async function callAI(prompt, { maxTokens = 2000, signal } = {}) {
  const p = S.aiProvider, key = (S.aiKeys[p] || "").trim(), model = aiModel();
  if (!key) throw { code: "nokey" };
  let url, headers = { "content-type": "application/json" }, body;
  if (p === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
    body = { model, max_tokens: maxTokens, system: AI_BASE, messages: [{ role: "user", content: prompt }] };
  } else if (p === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers.authorization = "Bearer " + key;
    body = { model, messages: [{ role: "system", content: AI_BASE }, { role: "user", content: prompt }] };
  } else {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = key;
    body = { systemInstruction: { parts: [{ text: AI_BASE }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens * 4 } };
  }
  let r;
  try { r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal }); }
  catch (e) { if (e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network" }; }
  const txt = await r.text();
  if (!r.ok) throw { code: "http", status: r.status, body: txt };
  const j = JSON.parse(txt);
  let out = "";
  if (p === "anthropic") out = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  else if (p === "openai") out = j.choices?.[0]?.message?.content || "";
  else out = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || "").join("");
  if (!out.trim()) throw { code: "empty" };
  return out.trim();
}
function aiError(e) {
  if (!e) return "AIの呼び出しに失敗しました。";
  switch (e.code) {
    case "nokey": return "AIを使うには「設定」でAPIキーを登録してください。";
    case "cancelled": return "";
    case "network": return "AIのサーバーに接続できませんでした。通信状況を確かめてください。";
    case "empty": return "AIから空の応答が返りました。もう一度お試しください。";
    case "http":
      if (e.status === 401 || e.status === 403) return "APIキーが無効か、権限がありません。設定を確かめてください。";
      if (e.status === 404) return "モデル名が見つかりません。設定のモデル名を確かめてください。";
      if (e.status === 429) return "利用上限かレート制限に達しました。少し待ってからお試しください。";
      return `AIの呼び出しに失敗しました（${e.status}）。`;
  }
  return "AIの呼び出しに失敗しました。";
}
async function runAI(box, cacheKey, prompt, opts = {}) {
  if (!aiReady()) { box.innerHTML = needKeyHTML(); return null; }
  box.innerHTML = '<div class="thinking">考えています…（10〜40秒ほど）</div>';
  try {
    const text = await callAI(prompt, opts);
    box.innerHTML = md(text);
    if (cacheKey) { S.ai[cacheKey] = text; save(); }
    return text;
  } catch (e) {
    const m = aiError(e);
    box.innerHTML = m ? `<p class="hint" style="color:var(--danger)">${esc(m)}</p>` : "";
    return null;
  }
}
function needKeyHTML() {
  return `<div class="hint">AIを使うにはAPIキーが必要です。<button class="btn small" data-tab="settings" style="margin-left:6px">設定を開く</button></div>`;
}
function jsonArray(text) {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { return null; }
}
const chunk = (text, size) => { const out = []; let cur = ""; for (const p of text.split("\n")) { if (cur.length + p.length > size && cur) { out.push(cur); cur = ""; } cur += p + "\n"; } if (cur.trim()) out.push(cur); return out; };

/* 簡易Markdown */
function md(text) {
  const lines = esc(text).split("\n"); let out = "", inList = false;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  for (const raw of lines) {
    const l = raw.trim();
    if (/^(?:[-・]|\*\s)/.test(l) && l.length > 1) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${inline(l.replace(/^(?:[-・]\s?|\*\s)/, ""))}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (!l) continue;
    out += /^#{1,4}\s/.test(l) ? `<h4>${inline(l.replace(/^#+\s/, ""))}</h4>` : `<p>${inline(l)}</p>`;
  }
  return out + (inList ? "</ul>" : "");
}

/* ============================================================
   表紙・行
   ============================================================ */
const COVER_COLORS = [["#22405F", "#EEF1F5"], ["#7B2D35", "#F6ECEA"], ["#4E6534", "#F1F3EA"], ["#5A4078", "#F2EEF6"], ["#8A6A34", "#FBF6EC"], ["#2F5A5A", "#E9F2F1"], ["#3A3A40", "#EFEFEF"], ["#6E4A2E", "#F6EEE6"]];
function cover(w, width = 92) {
  const [bg, fg] = COVER_COLORS[parseInt(hash(w.t), 36) % COVER_COLORS.length];
  const ts = Math.max(11, Math.round(width * 0.17)), as = Math.max(9, Math.round(width * 0.105));
  return `<div class="cover" style="width:${width}px;height:${Math.round(width * 1.42)}px;--c-bg:${bg};--c-fg:${fg}" aria-hidden="true">
    <span class="ct" style="font-size:${ts}px;max-height:${Math.round(width * 1.15)}px">${esc(w.t)}</span>
    <span class="ca" style="font-size:${as}px;max-height:${Math.round(width * 1.1)}px">${esc(w.a)}</span></div>`;
}
const tagsLine = w => `${w.ndc ? `<span class="tag">${esc(ndcLabel(w.ndc))}</span>` : ""}${w.kana ? `<span class="tag">${esc(w.kana)}</span>` : ""}${S.downloaded[w.id] ? '<span class="tag read">保存済み</span>' : ""}`;
const bookCard = (w, extra = "", act = "open") => `<button class="card-book" data-${act}="${w.id}">${cover(w)}<span class="t">${esc(w.t)}</span><span class="a">${esc(w.a)}</span>${extra}</button>`;
const listItem = (w, sub = "") => `<button class="item" data-open="${w.id}">${cover(w, 52)}<span class="body"><span class="title">${esc(w.t)}${w.st ? `<small style="font-weight:400"> ${esc(w.st)}</small>` : ""}</span><span class="meta">${esc(w.a)}</span><span>${tagsLine(w)}</span>${sub}</span></button>`;

/* ============================================================
   画面
   ============================================================ */
let tab = "home";
function setTab(t) { tab = t; $("#detail").hidden = true; render(); $("#view").scrollTop = 0; }
function refreshBanner() {
  const b = $("#banner"); if (!b) return;
  if (catState.status === "loading") { b.hidden = false; b.innerHTML = `<div class="thinking">${esc(catState.msg)}</div>`; }
  else if (catState.status === "error") { b.hidden = false; b.innerHTML = `<div style="flex:1">${esc(catState.msg)}</div><button class="btn small" data-act="reload-catalog">再試行</button>`; }
  else b.hidden = true;
}
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-current", String(b.dataset.tab === tab)));
  $("#vtitle").textContent = { home: "青空リーダー", search: "さがす", shelf: "本棚", phrases: "ことば", settings: "設定" }[tab];
  $("#view").innerHTML = ({ home: viewHome, search: viewSearch, shelf: viewShelf, phrases: viewPhrases, settings: viewSettings })[tab]();
  if (tab === "search") { const q = $("#q"); q.value = searchQ; }
  refreshBanner();
}

/* ---- ホーム ---- */
function viewHome() {
  const reading = Object.entries(S.shelf).filter(([, s]) => s.status === "reading").sort((a, b) => (b[1].opened || 0) - (a[1].opened || 0));
  let h = "";
  if (reading.length) {
    h += `<h2 class="sec">続きから読む</h2><div class="hscroll">` + reading.map(([id, s]) => {
      const w = workOf(id); if (!w) return "";
      return `<button class="card-book" data-read="${id}">${cover(w)}<span class="t">${esc(w.t)}</span><div class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></div><span class="a">${Math.round(s.progress * 100)}%</span></button>`;
    }).join("") + `</div>`;
  }
  h += `<h2 class="sec">あなたへのおすすめ ${S.recs && S.recs.byAI ? '<span class="badge-ai">✦ AI</span>' : ""}</h2>`;
  h += `<div class="chips" style="margin-bottom:10px">` + ALL_TAGS.map(t => `<button class="chip" data-tag="${t}" aria-pressed="${S.tags.includes(t)}">${t}</button>`).join("") + `</div>`;
  h += `<div class="row" style="margin-bottom:4px"><span class="hint" style="flex:1">好み・本棚・評価・保存したことばから選びます。</span><button class="btn small ai" data-act="recommend" id="rec-btn" ${catState.status !== "ready" ? "disabled" : ""}>✦ AIに選んでもらう</button></div>`;
  h += `<div id="rec-status"></div><div class="list" id="rec-list">${catState.status === "ready" ? recList() : ""}</div>`;
  if (catState.status === "ready") {
    const recent = [...CAT].sort((a, b) => (b.pub > a.pub ? 1 : -1)).slice(0, 16);
    h += `<h2 class="sec">最近公開された作品</h2><div class="hscroll">${recent.map(w => bookCard(w)).join("")}</div>`;
    h += `<p class="hint">収録 ${CAT.length.toLocaleString()} 作品（青空文庫）</p>`;
  }
  return h;
}
function candidates(limit = 80) {
  const owned = new Set(Object.keys(S.shelf)), score = {};
  const add = (w, s) => { if (!w || owned.has(w.id)) return; score[w.id] = (score[w.id] || 0) + s; };
  const aw = {}, nw = {};
  for (const [id, s] of Object.entries(S.shelf)) {
    const w = BY_ID[id]; if (!w) continue;
    const v = s.status === "finished" ? 1 + Math.max(0, (s.rating || 0) - 3) : s.status === "reading" ? 1.2 : 0.6;
    aw[w.aid] = (aw[w.aid] || 0) + v; if (w.ndc) nw[w.ndc] = (nw[w.ndc] || 0) + v;
  }
  const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  for (const [aid, v] of Object.entries(aw)) shuffle(BY_AUTHOR[aid] || []).slice(0, 15).forEach(w => add(w, 2 * v));
  const classic = CAT.filter(w => CLASSIC_AUTHORS.includes(w.a) && w.ndc.startsWith("91"));
  for (const [ndc, v] of Object.entries(nw)) shuffle(classic.filter(w => w.ndc === ndc)).slice(0, 15).forEach(w => add(w, v));
  for (const t of S.tags) {
    const names = new Set(TAG_AUTHORS[t] || []);
    shuffle(CAT.filter(w => names.has(w.a) && (!TAG_NDC[t] || w.ndc === TAG_NDC[t]))).slice(0, 15).forEach(w => add(w, 1.5));
  }
  shuffle(classic).slice(0, 30).forEach(w => add(w, 0.5));
  return Object.entries(score).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => BY_ID[id]);
}
function fallbackRecs() {
  if (S._fb && S._fb.key === S.tags.join() + Object.keys(S.shelf).length) return S._fb.items;
  const per = {}, out = [];
  for (const w of candidates()) {
    if (out.length >= 6) break;
    if ((per[w.aid] = (per[w.aid] || 0) + 1) > 2) continue;
    out.push({ id: w.id, reason: `${w.a}の${ndcLabel(w.ndc)}。` });
  }
  S._fb = { key: S.tags.join() + Object.keys(S.shelf).length, items: out };
  return out;
}
function recList() {
  const recs = (S.recs && S.recs.items) || fallbackRecs();
  return recs.filter(r => BY_ID[r.id]).map(r => listItem(BY_ID[r.id], `<span class="reason">${esc(r.reason)}</span>`)).join("");
}
async function recommend() {
  const st = $("#rec-status"), btn = $("#rec-btn");
  if (!aiReady()) { st.innerHTML = needKeyHTML(); return; }
  btn.disabled = true; st.innerHTML = '<div class="thinking" style="margin:8px 0">本棚とことばを読んで選書しています…</div>';
  const prof = [];
  if (S.tags.length) prof.push("好み: " + S.tags.join("、"));
  const fmt = st2 => Object.entries(S.shelf).filter(([, s]) => s.status === st2).map(([id, s]) => `『${s.t}』${s.a}${s.rating ? `（★${s.rating}）` : ""}`).join("、");
  if (fmt("finished")) prof.push("読んだ: " + fmt("finished"));
  if (fmt("reading")) prof.push("読んでいる: " + fmt("reading"));
  if (fmt("want")) prof.push("読みたい: " + fmt("want"));
  if (S.phrases.length) prof.push("保存したことば:\n" + S.phrases.slice(0, 10).map(p => `・「${p.text.slice(0, 80)}」（${p.title}）`).join("\n"));
  const cands = candidates();
  const prompt = `次の読者に、候補の中から次に読む作品を6作選んでください。

# 読者の読書プロフィール
${prof.join("\n") || "（まだ履歴なし。入門に向く名作を幅広く）"}

# 候補（ID|題名|作者|分類）
${cands.map(w => `${w.id}|${w.t}${w.st ? " " + w.st : ""}|${w.a}|${ndcLabel(w.ndc)}`).join("\n")}

# 条件
・必ず候補にあるIDだけを使う
・好みに近いものを中心に、新しい出会いになる意外な一作を1作まぜる
・同じ作家は最大2作
・reason は読者に語りかける40〜70字。読んだ作品や保存したことばと具体的に結びつける

# 出力
JSON配列のみ: [{"id":"000123","reason":"…"}]`;
  try {
    const arr = jsonArray(await callAI(prompt, { maxTokens: 1500 }));
    const valid = new Set(cands.map(w => w.id));
    const items = (arr || []).map(r => ({ id: String(r && r.id || "").padStart(6, "0"), reason: String(r && r.reason || "") })).filter(r => valid.has(r.id) && r.reason);
    if (!items.length) throw { code: "empty" };
    S.recs = { byAI: true, items, at: Date.now() }; save();
    if (tab === "home") render();
  } catch (e) {
    st.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(aiError(e))}</p>`;
    btn.disabled = false;
  }
}

/* ---- さがす ---- */
let searchQ = "";
function viewSearch() {
  return `<input type="search" id="q" placeholder="作品名・作家名（ひらがなでも）" autocomplete="off" aria-label="検索" enterkeyhint="search">
  <div id="results">${searchResults()}</div>`;
}
function searchResults() {
  if (catState.status !== "ready") return `<div class="empty"><b>目録を準備しています</b>初回は青空文庫の目録（数MB）をダウンロードします。</div>`;
  if (!norm(searchQ)) {
    const authors = CLASSIC_AUTHORS.filter(a => authorIdByName(a));
    return `<h2 class="sec">作家から</h2><div class="chips">${authors.map(a => `<button class="chip" data-author="${esc(a)}">${esc(a)}</button>`).join("")}</div>
      <p class="hint" style="margin-top:18px">作品名・作家名で、青空文庫の${CAT.length.toLocaleString()}作品から探せます。</p>`;
  }
  const hits = search(searchQ);
  return hits.length ? `<div class="list">${hits.map(w => listItem(w)).join("")}</div>${hits.length >= 120 ? '<p class="hint">上位120件を表示しています。</p>' : ""}`
    : `<div class="empty"><b>見つかりませんでした</b>作品名か作家名で探してください。</div>`;
}

/* ---- 本棚 ---- */
let shelfFilter = "all";
function viewShelf() {
  const all = Object.entries(S.shelf);
  const count = st => all.filter(([, s]) => st === "all" || s.status === st).length;
  let h = `<div class="seg">${["all", "want", "reading", "finished"].map(k => `<button data-shelf="${k}" aria-pressed="${shelfFilter === k}">${k === "all" ? "すべて" : STATUS[k]} ${count(k)}</button>`).join("")}</div>`;
  const shown = all.filter(([, s]) => shelfFilter === "all" || s.status === shelfFilter).sort((a, b) => (b[1].opened || b[1].added) - (a[1].opened || a[1].added));
  if (!shown.length) return h + `<div class="empty"><b>本棚は空です</b>作品ページの「本棚に追加」から加えられます。</div>`;
  return h + `<div class="grid-shelf">` + shown.map(([id, s]) => {
    const w = workOf(id);
    const extra = (s.status === "reading" ? `<div class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : "") +
      (s.rating ? `<span class="a" style="color:#C88A2E">${"★".repeat(s.rating)}</span>` : "") + `<span class="a">${STATUS[s.status]}</span>`;
    return bookCard(w, extra);
  }).join("") + `</div>`;
}

/* ---- ことば ---- */
let phraseQ = "";
function viewPhrases() {
  if (!S.phrases.length) return `<div class="empty"><b>保存したことばはまだありません</b>読書中に文字を選んで「ことばを保存」を押すと、ここに集まります。</div>`;
  const q = phraseQ.trim();
  const list = S.phrases.filter(p => !q || [p.text, p.title, p.author, p.note].some(x => (x || "").includes(q)));
  return `<input type="search" id="pq" placeholder="ことば・作品・メモを検索" value="${esc(phraseQ)}" aria-label="ことばを検索" style="margin-bottom:12px">` +
    list.map(p => `<div class="panel">
      <div class="quote">${esc(p.text)}</div>
      <div class="row hint" style="margin-top:6px"><span>${esc(p.author)}『${esc(p.title)}』</span><span class="spacer"></span><span>${new Date(p.at).toLocaleDateString("ja-JP")}</span></div>
      ${p.note ? `<div class="ai-out" style="margin-top:8px;font-size:13px">${md(p.note)}</div>` : ""}
      <div class="row" style="margin-top:10px;gap:6px">
        <button class="btn small" data-share="${p.id}">共有</button>
        <button class="btn small" data-note="${p.id}">メモ</button>
        <button class="btn small" data-jump="${p.id}">本文へ</button>
        <span class="spacer"></span>
        <button class="btn small" data-delphrase="${p.id}" style="color:var(--danger)">削除</button>
      </div></div>`).join("");
}

/* ---- 設定 ---- */
function viewSettings() {
  const p = S.aiProvider;
  return `<h2 class="sec">AI</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:10px">
    <div class="seg">${Object.entries(PROVIDERS).map(([k, v]) => `<button data-provider="${k}" aria-pressed="${p === k}">${v.label.replace(/（.*）/, "")}</button>`).join("")}</div>
    <label class="hint" for="ai-key">${esc(PROVIDERS[p].label)} のAPIキー</label>
    <input type="password" id="ai-key" value="${esc(S.aiKeys[p] || "")}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="APIキーを貼り付け">
    <label class="hint" for="ai-model">モデル名（空欄なら ${esc(PROVIDERS[p].model)}）</label>
    <input type="text" id="ai-model" value="${esc(S.aiModels[p] || "")}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="row"><button class="btn primary" data-act="ai-test">保存して接続テスト</button><a href="${PROVIDERS[p].keyUrl}" target="_blank" rel="noopener" class="hint">キーを取得する</a></div>
    <div id="ai-test-out" class="hint"></div>
    <p class="hint" style="margin:0">キーはこの端末のブラウザ内にだけ保存され、選んだサービスへ直接送られます。料金はそのサービスのあなたのアカウントにかかります。</p>
  </div>
  <h2 class="sec">論文検索</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:8px">
    <label class="hint" for="cinii">CiNii Research のアプリID（任意）</label>
    <input type="text" id="cinii" value="${esc(S.ciniiAppId)}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <p class="hint" style="margin:0">論文は J-STAGE（登録不要）で探します。CiNiiのアプリIDを入れると、大学の紀要論文なども加わります。</p>
  </div>
  <h2 class="sec">読書画面の既定</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:10px">${styleControls(S.reader)}</div>
  <h2 class="sec">作品目録と保存データ</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:8px">
    <div class="hint">目録 ${CAT.length.toLocaleString()}作品${catState.at ? `（${new Date(catState.at).toLocaleDateString("ja-JP")} 更新）` : ""}・保存済みの本文 ${Object.keys(S.downloaded).length}作品・本棚 ${Object.keys(S.shelf).length}冊・ことば ${S.phrases.length}件</div>
    <div class="row" style="flex-wrap:wrap;gap:8px"><button class="btn small" data-act="reload-catalog">目録を今すぐ更新</button><button class="btn small" data-act="paste">本文を貼り付けて読む</button></div>
    <div id="reset-area"><button class="btn small" data-act="reset-ask" style="color:var(--danger)">すべて消去する</button></div>
  </div>
  <h2 class="sec">ホーム画面に追加</h2>
  <div class="panel"><p style="margin:0">iPhoneのSafariで、共有ボタン →「ホーム画面に追加」を選ぶと、アプリとして起動できます。一度読んだ本文と目録は端末に保存されるので、通信がなくても読めます。</p></div>
  <p class="hint" style="margin-top:18px">作品本文と目録は<a href="https://www.aozora.gr.jp/" target="_blank" rel="noopener">青空文庫</a>の公開データです。入力・校正に携わったボランティアの方々に感謝します。</p>`;
}
function styleControls(r) {
  const seg = (name, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button data-style="${name}" data-val="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join("")}</div>`;
  return `${seg("vertical", [[true, "縦書き"], [false, "横書き"]], r.vertical)}
    ${seg("font", [["mincho", "明朝"], ["gothic", "ゴシック"]], r.font)}
    ${seg("theme", [["paper", "生成り"], ["white", "白"], ["dark", "夜"]], r.theme)}
    ${seg("size", [[16, "小"], [19, "中"], [22, "大"], [26, "特大"]], r.size)}
    ${seg("lh", [[1.7, "行間 狭"], [1.9, "標準"], [2.2, "広"]], r.lh)}`;
}

/* ============================================================
   作品ページ
   ============================================================ */
let detailId = null, detailPane = "about", paperCache = {};
function openDetail(id) { detailId = id; detailPane = "about"; renderDetail(); $("#detail").hidden = false; const b = $("#detail .layer-body"); if (b) b.scrollTop = 0; }
function renderDetail() {
  const w = workOf(detailId); if (!w) return;
  const s = S.shelf[w.id];
  const others = w.aid ? (BY_AUTHOR[w.aid] || []).filter(x => x.id !== w.id) : [];
  let h = `<div class="layer-head"><button class="icon-btn" data-act="close-detail" aria-label="戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6l-6 6 6 6"/></svg></button><span class="spacer"></span></div>
  <div class="layer-body">
  <div class="detail-head">${cover(w, 104)}<div class="info">
    <h3>${esc(w.t)}</h3>${w.st ? `<div class="hint">${esc(w.st)}</div>` : ""}<div>${esc(w.a)}</div><div>${tagsLine(w)}</div>
    <button class="btn primary" data-read="${w.id}">${s && s.progress > 0.01 && s.status !== "finished" ? "続きを読む" : "読む"}</button>
    <select id="status-sel" aria-label="本棚の状態">
      <option value="">${s ? "本棚から外す" : "＋ 本棚に追加…"}</option>
      ${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${s && s.status === k ? "selected" : ""}>${l}</option>`).join("")}
    </select>
  </div></div>
  <div class="seg" style="margin:18px 0 14px">${[["about", "作品について"], ["commentary", "解説"], ["critique", "論文・批評"]].map(([k, l]) => `<button data-pane="${k}" aria-pressed="${detailPane === k}">${l}</button>`).join("")}</div>`;

  if (detailPane === "about") {
    if (s) h += `<div class="row" style="margin-bottom:12px"><span class="hint">あなたの評価</span><span class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" aria-label="${n}つ星">${n <= (s.rating || 0) ? "★" : "☆"}</button>`).join("")}</span><span class="spacer"></span>${s.progress > 0 ? `<span class="hint">${Math.round(s.progress * 100)}% 読了</span>` : ""}</div>`;
    h += `<dl class="kv">${w.ndc ? `<dt>分類</dt><dd>NDC ${esc(w.ndc)}（${esc(ndcLabel(w.ndc))}）</dd>` : ""}${w.kana ? `<dt>文字遣い</dt><dd>${esc(w.kana)}</dd>` : ""}${w.first ? `<dt>初出</dt><dd>${esc(w.first)}</dd>` : ""}${w.pub ? `<dt>青空文庫公開</dt><dd>${esc(w.pub)}</dd>` : ""}</dl>`;
    if (w.card) h += `<p style="margin:12px 0 0"><a href="${esc(w.card)}" target="_blank" rel="noopener">青空文庫の図書カードを開く</a></p>`;
    const phr = S.phrases.filter(p => p.workId === w.id);
    if (phr.length) h += `<h2 class="sec">この作品で保存したことば</h2>` + phr.map(p => `<div class="panel"><div class="quote">${esc(p.text)}</div></div>`).join("");
    if (others.length) h += `<h2 class="sec">${esc(w.a)}のほかの作品</h2><div class="hscroll">${others.slice(0, 30).map(x => bookCard(x)).join("")}</div>`;
  } else if (detailPane === "commentary") {
    const key = "commentary|" + w.id;
    h += `<div class="panel" id="wiki-box"><div class="thinking">Wikipediaを確認中…</div></div>
      <div class="row" style="margin:18px 0 10px"><span class="badge-ai">✦ AI</span><span class="hint">これから読む人向けの作品解説</span></div>
      <div class="panel"><div class="ai-out" id="ai-box">${S.ai[key] ? md(S.ai[key]) : `<p class="hint">背景・主題・文学史上の位置づけ・読むときのヒントを、ネタバレなしでまとめます。</p>`}</div></div>
      <div class="row" style="margin-top:10px"><button class="btn ai" data-act="gen-commentary">${S.ai[key] ? "作り直す" : "✦ 解説を書いてもらう"}</button></div>
      <p class="hint">AIの解説は誤りを含むことがあります。事実関係は研究書・論文で確かめてください。</p>`;
    setTimeout(() => loadWiki(w), 0);
  } else {
    const key = "critique|" + w.id, q = encodeURIComponent(`${w.t} ${w.a}`);
    h += `<div class="row" style="margin-bottom:10px"><span class="badge-ai">✦ AI</span><span class="hint">見つかった論文の題名・要旨から、研究の論点を整理</span></div>
      <div class="panel"><div class="ai-out" id="ai-box">${S.ai[key] ? md(S.ai[key]) : `<p class="hint">論文の一覧を読み込んだあとに使えます。</p>`}</div></div>
      <div class="row" style="margin-top:10px"><button class="btn ai" data-act="gen-critique" id="crit-btn">${S.ai[key] ? "作り直す" : "✦ 論点を整理してもらう"}</button></div>
      <h2 class="sec">論文</h2><div id="paper-box"><div class="thinking">J-STAGEを検索中…</div></div>
      <div class="panel" style="display:flex;flex-direction:column;gap:6px;margin-top:12px">
        <a href="https://www.jstage.jst.go.jp/result/global/-char/ja?globalSearchKey=${q}" target="_blank" rel="noopener">J-STAGEで検索</a>
        <a href="https://cir.nii.ac.jp/all?q=${q}" target="_blank" rel="noopener">CiNii Researchで検索</a>
        <a href="https://scholar.google.com/scholar?hl=ja&q=${q}" target="_blank" rel="noopener">Google Scholarで検索</a>
      </div>`;
    setTimeout(() => loadPapers(w), 0);
  }
  h += `</div>`;
  $("#detail").innerHTML = h;
}
async function loadWiki(w) {
  const box = $("#wiki-box"); if (!box) return;
  if (w._wiki === undefined) {
    w._wiki = null;
    for (const cand of [`${w.t} (小説)`, w.t]) {
      try {
        const r = await fetch(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cand.replace(/ /g, "_"))}`);
        if (!r.ok) continue;
        const j = await r.json();
        if (j.type === "disambiguation" || !j.extract || !j.extract.includes(w.a.slice(0, 2))) continue;
        w._wiki = { extract: j.extract, url: j.content_urls?.mobile?.page || "" }; break;
      } catch (e) {}
    }
  }
  if (!$("#wiki-box")) return;
  $("#wiki-box").innerHTML = w._wiki
    ? `<div class="hint" style="font-weight:700;margin-bottom:6px">Wikipediaより</div><p style="margin:0">${esc(w._wiki.extract)}</p>${w._wiki.url ? `<a class="hint" href="${esc(w._wiki.url)}" target="_blank" rel="noopener">記事を開く</a>` : ""}`
    : `<p class="hint" style="margin:0">Wikipediaに該当する記事は見つかりませんでした。</p>`;
}
function genCommentary() {
  const w = workOf(detailId);
  runAI($("#ai-box"), "commentary|" + w.id, `『${w.t}』（${w.a}）について、これから読む人向けの作品解説を書いてください。
目録情報：分類 ${ndcLabel(w.ndc)}／初出 ${w.first || "不明"}
${w._wiki ? "参考（Wikipedia冒頭）：\n" + w._wiki.extract : ""}

形式（Markdownの見出し##を使う）:
## 作品の背景
## 主題と特徴
## 文学史上の位置づけ
## 読むときのヒント
（結末のネタバレは避ける）
合計700字程度。`);
}

/* 論文：J-STAGE（＋CiNii） */
async function jstage(params) {
  const u = new URL("https://api.jstage.jst.go.jp/searchapi/do");
  u.searchParams.set("service", "3"); u.searchParams.set("count", "30");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
  const pick = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent.trim() : ""; };
  return [...doc.getElementsByTagName("entry")].map(e => ({
    title: pick(e, "article_title ja") || pick(e, "article_title en"),
    url: pick(e, "article_link ja") || pick(e, "article_link en"),
    journal: pick(e, "material_title ja"),
    year: pick(e, "pubyear"),
    authors: [...e.querySelectorAll("author ja name")].map(n => n.textContent.trim()).slice(0, 3).join("、"),
    abstract: "", source: "J-STAGE",
  })).filter(p => p.title);
}
async function cinii(q) {
  if (!S.ciniiAppId) return [];
  const u = new URL("https://cir.nii.ac.jp/opensearch/articles");
  u.searchParams.set("q", q); u.searchParams.set("count", "30"); u.searchParams.set("format", "json"); u.searchParams.set("appid", S.ciniiAppId);
  const r = await fetch(u); if (!r.ok) return [];
  const j = await r.json();
  const str = v => typeof v === "string" ? v : Array.isArray(v) ? v.map(str).filter(Boolean).join("、") : v && typeof v === "object" ? str(v["@value"] || v["@id"] || v["foaf:name"]) : "";
  return (j.items || []).map(it => ({ title: str(it.title), url: str(it.link), journal: str(it["prism:publicationName"]), year: str(it["prism:publicationDate"] || it["dc:date"]).slice(0, 4), authors: str(it["dc:creator"]), abstract: str(it.description), source: "CiNii" })).filter(p => p.title);
}
async function loadPapers(w) {
  const box = () => $("#paper-box");
  if (!paperCache[w.id]) {
    let list = [], failed = false;
    try {
      list = await jstage({ text: `${w.t} ${w.a}` });
      if (list.length < 5) list = list.concat(await jstage({ article: w.t }));
    } catch (e) { failed = true; }
    try { list = (await cinii(`${w.t} ${w.a}`)).concat(list); } catch (e) {}
    const seen = new Set(), t = norm(w.t);
    list = list.filter(p => { const k = norm(p.title); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (norm(b.title).includes(t) - norm(a.title).includes(t)) || (b.year > a.year ? 1 : -1));
    paperCache[w.id] = { list, failed: failed && !list.length };
  }
  const { list, failed } = paperCache[w.id];
  if (!box()) return;
  if (failed) { box().innerHTML = `<p class="hint">論文データベースに接続できませんでした。下のリンクから検索できます。</p>`; return; }
  if (!list.length) { box().innerHTML = `<p class="hint">J-STAGEで「${esc(w.t)} ${esc(w.a)}」に当たる論文は見つかりませんでした。下のリンクからも探せます。</p>`; return; }
  box().innerHTML = `<p class="hint" style="margin-top:0">${list.length}件</p>` + list.map((p, i) => `<a class="item" href="${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block">
    <span class="body"><span class="title" style="font-size:14.5px">[${i + 1}] ${esc(p.title)}</span><span class="meta">${esc([p.authors, p.journal, p.year].filter(Boolean).join("／"))}・${p.source}</span></span></a>`).join("");
}
async function genCritique() {
  const w = workOf(detailId);
  const papers = (paperCache[w.id] && paperCache[w.id].list) || [];
  const list = papers.slice(0, 25).map((p, i) => `${i + 1}. ${p.title}／${p.authors}／${p.journal} ${p.year}${p.abstract ? "\n   要旨: " + p.abstract.slice(0, 300) : ""}`).join("\n");
  const prompt = papers.length
    ? `『${w.t}』（${w.a}）に関する研究論文の検索結果です。題名・要旨から読み取れる範囲で、この作品が研究上どのような観点から論じられてきたかを整理してください。

${list}

形式（Markdownの見出し##を使う）:
## 主な論点
（観点ごとに太字の小見出し＋2〜3文。根拠となる論文番号を [3] のように添える）
## 初めて読む人へのおすすめ
（上の一覧から2〜3本、理由つきで）
論文の本文は読んでいないので、題名・要旨から推測できる範囲を超えて断定しないこと。`
    : `『${w.t}』（${w.a}）が文学研究・批評でどのような観点から論じられてきたかを、大学生向けに整理してください。
## 主な論点
（3〜5観点、それぞれ2〜3文）
## 調べるときの検索語
（J-STAGEやCiNiiで使う日本語の検索語を4〜6個）
特定の研究者名・論文名・発表年は、確実なものだけ挙げ、不確かなら書かないこと。`;
  runAI($("#ai-box"), "critique|" + w.id, prompt);
}

/* ============================================================
   読書画面
   ============================================================ */
let readingId = null, plainCache = "", progressTimer = null;
function applyReaderStyle() {
  const r = S.reader, el = $("#reader"), page = $("#page");
  el.dataset.rtheme = r.theme; el.dataset.vertical = String(r.vertical);
  page.style.setProperty("--r-size", r.size + "px");
  page.style.setProperty("--r-lh", r.lh);
  page.style.setProperty("--r-font", r.font === "gothic" ? "var(--sans)" : "var(--serif)");
}
const maxScroll = p => S.reader.vertical ? p.scrollWidth - p.clientWidth : p.scrollHeight - p.clientHeight;
function ratio() { const p = $("#page"), m = maxScroll(p); if (m <= 0) return 1; return Math.min(1, Math.max(0, (S.reader.vertical ? Math.abs(p.scrollLeft) : p.scrollTop) / m)); }
function restore(r) { const p = $("#page"), m = maxScroll(p); if (S.reader.vertical) p.scrollLeft = -r * m; else p.scrollTop = r * m; }
async function openReader(id, jumpTo) {
  const w = workOf(id); if (!w) return;
  readingId = id;
  const s = ensureShelf(w, "reading");
  if (s.status === "want") s.status = "reading";
  s.opened = Date.now(); if (w.html) s.html = w.html; save();
  $("#r-title").textContent = w.t; $("#r-author").textContent = w.a;
  applyReaderStyle();
  $("#page").innerHTML = `<div class="r-loading"><div class="thinking">本文を読み込み中…</div></div>`;
  $("#reader").hidden = false; $("#reader").classList.remove("hide-chrome");
  let t;
  try { t = await loadText(w); }
  catch (e) {
    if (readingId !== id) return;
    $("#page").innerHTML = `<div class="r-loading"><p>${esc(e.message)}</p><div class="row" style="gap:8px;justify-content:center"><button class="btn" data-read="${id}">再試行</button><button class="btn" data-act="paste">貼り付けて読む</button></div></div>`;
    return;
  }
  if (readingId !== id) return;
  plainCache = aozoraToPlain(t.src);
  $("#page").innerHTML = `<div class="w-head"><p class="w-title">${esc(w.t)}</p>${w.st ? `<p class="w-author">${esc(w.st)}</p>` : ""}<p class="w-author">${esc(w.a)}</p></div>${aozoraToHTML(t.src)}`;
  requestAnimationFrame(() => { restore(jumpTo ?? (s.status === "finished" ? 0 : s.progress)); updateProgress(); });
  setTimeout(() => { restore(jumpTo ?? (s.status === "finished" ? 0 : s.progress)); updateProgress(); }, 350);
}
function updateProgress() {
  if (!readingId || !plainCache) return;
  const r = ratio(), s = S.shelf[readingId];
  $("#r-bar").style.width = Math.round(r * 100) + "%";
  $("#r-pct").textContent = Math.round(r * 100) + "%";
  $("#r-finish").hidden = !(r > 0.95 && s && s.status !== "finished");
  if (s && s.status !== "finished") { s.progress = r; clearTimeout(progressTimer); progressTimer = setTimeout(save, 500); }
}
function closeReader() { save(); readingId = null; plainCache = ""; $("#reader").hidden = true; $("#selbar").hidden = true; if (!$("#detail").hidden) renderDetail(); render(); }

function selectionInfo() {
  const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!$("#page").contains(range.commonAncestorContainer)) return null;
  const frag = range.cloneContents(); frag.querySelectorAll("rt,rp").forEach(n => n.remove());
  const text = frag.textContent.replace(/\s+/g, "").trim();
  if (!text) return null;
  let p = range.startContainer; while (p && p.nodeName !== "P" && p !== $("#page")) p = p.parentNode;
  const plain = n => { if (!n) return ""; const c = n.cloneNode(true); c.querySelectorAll && c.querySelectorAll("rt,rp").forEach(x => x.remove()); return c.textContent || ""; };
  let ctx = "";
  if (p && p.nodeName === "P") {
    const sib = n => n && n.nodeName === "P" ? n : null;
    ctx = plain(sib(p.previousElementSibling)).slice(-80) + plain(p) + plain(sib(p.nextElementSibling)).slice(0, 80);
    if (ctx.length > 360) { const i = Math.max(0, ctx.indexOf(text)); ctx = ctx.slice(Math.max(0, i - 150), i + text.length + 150); }
  }
  return { text: text.slice(0, 200), context: ctx.trim(), pos: ratio() };
}
let lastSel = null;
document.addEventListener("selectionchange", () => {
  if ($("#reader").hidden) return;
  const info = selectionInfo();
  if (info) lastSel = info;
  $("#selbar").hidden = !info;
});
function savePhrase(sel, note = "") {
  const w = workOf(readingId);
  S.phrases.unshift({ id: "p" + Date.now().toString(36), text: sel.text, context: sel.context, note, workId: w.id, title: w.t, author: w.a, pos: sel.pos, at: Date.now() });
  save(); toast("ことばを保存しました");
}

/* ============================================================
   シート
   ============================================================ */
let sheetCtl = null;
function openSheet(title, html) { $("#sh-title").textContent = title; $("#sh-body").innerHTML = html; $("#sheet-wrap").hidden = false; }
function closeSheet() { if (sheetCtl) { sheetCtl.abort(); sheetCtl = null; } $("#sheet-wrap").hidden = true; }

function lookup(sel) {
  const w = workOf(readingId);
  const hl = esc(sel.context).replace(esc(sel.text), `<mark>${esc(sel.text)}</mark>`);
  openSheet("ことばの意味", `<div style="font-family:var(--serif);font-size:24px;font-weight:700">${esc(sel.text)}</div>
    ${sel.context ? `<div class="ctx">…${hl}…</div>` : ""}
    <div><span class="badge-ai">✦ AI</span></div>
    <div class="ai-out" id="lk-out"></div>
    <div class="row"><button class="btn primary" id="lk-save">解説ごと保存</button><button class="btn" data-act="close-sheet">閉じる</button></div>`);
  const key = "explain|" + w.id + "|" + sel.text;
  let result = S.ai[key] || "";
  $("#lk-save").onclick = () => { savePhrase(sel, result); closeSheet(); };
  if (result) { $("#lk-out").innerHTML = md(result); return; }
  sheetCtl = new AbortController();
  runAI($("#lk-out"), key, `『${w.t}』（${w.a}）を読んでいる読者が、次の語句の意味を知りたがっています。

語句：「${sel.text}」
前後の文脈：「${sel.context}」

次の形式で簡潔に答えてください（見出しは付けない）。
**読み**：ひらがな
**この文脈での意味**：1〜3文、現代語で
**補足**：旧仮名・旧字体、当時の風俗や制度、典故など理解に役立つ背景（なければ省略）
**言い換え**：現代語での自然な言い換えを一つ`, { maxTokens: 800, signal: sheetCtl.signal }).then(t => { if (t) result = t; });
}

let sumScope = "until";
function openSummary() {
  const w = workOf(readingId);
  const r = ratio(), bucket = Math.max(5, Math.floor(r * 20) * 5);
  const src = sumScope === "until" ? plainCache.slice(0, Math.max(1500, Math.round(plainCache.length * bucket / 100))) : plainCache;
  const parts = chunk(src, 12000).length;
  const key = `summary|${w.id}|${sumScope === "until" ? "u" + bucket : "whole"}`;
  openSheet("あらすじ", `<div class="seg"><button data-scope="until" aria-pressed="${sumScope === "until"}">いま読んだところまで</button><button data-scope="whole" aria-pressed="${sumScope === "whole"}">作品全体</button></div>
    <p class="hint" style="margin:0">${sumScope === "until" ? `先の展開に触れないよう、いまの位置（約${bucket}%）までの本文だけをAIに渡します。` : "結末まで含めて要約します。"} 対象 約${src.length.toLocaleString()}字${parts > 1 ? `／${parts}回に分けて要約してからまとめます（APIを計${parts + 1}回呼び出します）` : ""}。</p>
    <div class="panel"><div class="ai-out" id="sum-out">${S.ai[key] ? md(S.ai[key]) : '<p class="hint">ボタンを押すと作成します。</p>'}</div></div>
    <div class="row"><button class="btn ai" id="sum-go">${S.ai[key] ? "作り直す" : "✦ あらすじを作る"}</button></div>`);
  $("#sum-go").onclick = () => makeSummary(w, src, key);
}
async function makeSummary(w, src, key) {
  const box = $("#sum-out"), btn = $("#sum-go");
  if (!aiReady()) { box.innerHTML = needKeyHTML(); return; }
  btn.disabled = true; sheetCtl = new AbortController();
  const spoil = sumScope === "until" ? "\n読者はまだこの先を読んでいません。与えた本文より先の展開には絶対に触れないでください。" : "";
  const fmt = `## ひとことで\n（40字以内）\n## あらすじ\n（300〜600字）\n## 登場人物\n（主要人物を箇条書き）\n## 読みどころ\n（2〜3点）`;
  const parts = chunk(src, 12000);
  try {
    if (parts.length === 1) {
      await runAI(box, key, `『${w.t}』（${w.a}）の本文です。次の形式で要約してください。${spoil}\n${fmt}\n\n---本文---\n${src}`, { signal: sheetCtl.signal });
    } else {
      const notes = new Array(parts.length); let done = 0, next = 0;
      const worker = async () => {
        while (next < parts.length) {
          const i = next++;
          notes[i] = await callAI(`『${w.t}』（${w.a}）の本文の一部（${i + 1}/${parts.length}）です。この部分の出来事・人物の動き・重要な描写を300字程度の箇条書きで要約してください。\n---本文---\n${parts[i]}`, { maxTokens: 1200, signal: sheetCtl.signal });
          done++; box.innerHTML = `<div class="thinking">区切りごとに要約中… ${done}/${parts.length}</div>`;
        }
      };
      box.innerHTML = `<div class="thinking">区切りごとに要約中… 0/${parts.length}</div>`;
      await Promise.all([worker(), worker(), worker()]);
      await runAI(box, key, `『${w.t}』（${w.a}）を順に区切って要約したメモです。統合して次の形式でまとめてください。${spoil}\n${fmt}\n\n---メモ---\n${notes.map((n, i) => `【${i + 1}】\n${n}`).join("\n\n")}`, { signal: sheetCtl.signal });
    }
  } catch (e) {
    const m = aiError(e); if (m) box.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(m)}</p>`;
  }
  btn.disabled = false; btn.textContent = "作り直す";
}
function openStyleSheet() { openSheet("表示", `<div style="display:flex;flex-direction:column;gap:10px">${styleControls(S.reader)}</div>`); }
function openNote(id) {
  const p = S.phrases.find(x => x.id === id); if (!p) return;
  openSheet("メモ", `<div class="quote">${esc(p.text)}</div>${p.context ? `<div class="ctx">${esc(p.context)}</div>` : ""}
    <label class="hint" for="note-ta">メモ</label><textarea id="note-ta">${esc(p.note || "")}</textarea>
    <div class="row"><button class="btn primary" id="note-save">保存</button></div>`);
  $("#note-save").onclick = () => { p.note = $("#note-ta").value; save(); closeSheet(); render(); };
}
function openRate() {
  openSheet("読了おめでとうございます", `<p style="margin:0">『${esc(workOf(readingId).t)}』の評価をつけると、おすすめに反映されます。</p><div class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-finrate="${n}" style="font-size:30px">☆</button>`).join("")}</div>`);
  document.querySelectorAll("[data-finrate]").forEach(b => b.onclick = () => { S.shelf[readingId].rating = +b.dataset.finrate; save(); closeSheet(); toast("評価を保存しました"); });
}

/* 貼り付けシート */
let pasteHTML = "";
function openPaste() {
  pasteHTML = "";
  openSheet("本文を貼り付けて読む", `<p class="hint" style="margin:0">目録にない作品や、本文を取得できないときに使います。青空文庫の本文ページを全選択してコピーし、下に貼り付けてください。</p>
    <textarea id="paste-ta" placeholder="ここに貼り付け" style="min-height:130px;font-family:var(--serif)"></textarea>
    <div id="paste-info" class="hint">ルビ（ふりがな）もそのまま取り込みます。</div>
    <div class="row" style="gap:8px"><input type="text" id="paste-title" placeholder="作品名" aria-label="作品名"><input type="text" id="paste-author" placeholder="作者" aria-label="作者" style="max-width:40%"></div>
    <button class="btn primary block" id="paste-go" disabled>この本文で読む</button>`);
  const ta = $("#paste-ta");
  ta.addEventListener("paste", e => { pasteHTML = (e.clipboardData && e.clipboardData.getData("text/html")) || ""; setTimeout(previewPaste, 0); });
  ta.addEventListener("input", () => { if (!ta.value) pasteHTML = ""; previewPaste(); });
  $("#paste-go").onclick = submitPaste;
}
function previewPaste() {
  const r = parsePasted(pasteHTML, $("#paste-ta").value);
  const n = aozoraToPlain(r.src).length;
  if (r.title && !$("#paste-title").value) $("#paste-title").value = r.title;
  if (r.author && !$("#paste-author").value) $("#paste-author").value = r.author;
  $("#paste-info").textContent = n ? `約${n.toLocaleString()}字・ふりがな${(r.src.match(/《/g) || []).length}か所を読み取りました。` : "ルビ（ふりがな）もそのまま取り込みます。";
  $("#paste-go").disabled = n < 20;
}
async function submitPaste() {
  const r = parsePasted(pasteHTML, $("#paste-ta").value);
  const title = $("#paste-title").value.trim() || r.title || "無題", author = $("#paste-author").value.trim() || r.author || "作者不明";
  const found = CAT.find(w => norm(w.t) === norm(title) && norm(w.a) === norm(author));
  const w = found || { id: "imp-" + hash(title + author), t: title, a: author, aid: "", ndc: "", kana: "", html: "" };
  await idb.set("text:" + w.id, { src: r.src, at: Date.now() });
  S.downloaded[w.id] = Date.now();
  ensureShelf(w, "reading"); save();
  closeSheet(); render();
  openReader(w.id);
}

/* ============================================================
   イベント
   ============================================================ */
document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-open], [data-read]");
  if (!t) {
    if (e.target.closest("#page") && getSelection().isCollapsed && plainCache) {
      const p = $("#page"), rect = p.getBoundingClientRect(), x = (e.clientX - rect.left) / rect.width;
      const step = S.reader.vertical ? p.clientWidth - 48 : p.clientHeight - 60;
      if (x < 0.25) S.reader.vertical ? p.scrollBy({ left: -step, behavior: "smooth" }) : p.scrollBy({ top: step, behavior: "smooth" });
      else if (x > 0.75) S.reader.vertical ? p.scrollBy({ left: step, behavior: "smooth" }) : p.scrollBy({ top: -step, behavior: "smooth" });
      else $("#reader").classList.toggle("hide-chrome");
    }
    return;
  }
  const d = t.dataset;
  if (d.tab) { closeSheet(); if (!$("#reader").hidden) closeReader(); return setTab(d.tab); }
  if (d.read) return openReader(d.read);
  if (d.open) return openDetail(d.open);
  if (d.tag) { S.tags = S.tags.includes(d.tag) ? S.tags.filter(x => x !== d.tag) : [...S.tags, d.tag]; save(); return render(); }
  if (d.author) { searchQ = d.author; return render(); }
  if (d.shelf) { shelfFilter = d.shelf; return render(); }
  if (d.pane) { detailPane = d.pane; return renderDetail(); }
  if (d.rate) { const s = S.shelf[detailId]; s.rating = s.rating === +d.rate ? 0 : +d.rate; save(); return renderDetail(); }
  if (d.scope) { sumScope = d.scope; return openSummary(); }
  if (d.provider) { S.aiProvider = d.provider; save(); return render(); }
  if (d.style) {
    const v = d.val === "true" ? true : d.val === "false" ? false : isNaN(+d.val) ? d.val : +d.val;
    const keep = readingId && plainCache ? ratio() : 0;
    S.reader[d.style] = v; save();
    if (readingId) { applyReaderStyle(); requestAnimationFrame(() => { restore(keep); updateProgress(); }); openStyleSheet(); }
    else render();
    return;
  }
  if (d.share) {
    const p = S.phrases.find(x => x.id === d.share), s = `「${p.text}」\n——${p.author}『${p.title}』`;
    if (navigator.share) navigator.share({ text: s }).catch(() => {});
    else navigator.clipboard?.writeText(s).then(() => toast("コピーしました"), () => toast("コピーできませんでした"));
    return;
  }
  if (d.note) return openNote(d.note);
  if (d.jump) { const p = S.phrases.find(x => x.id === d.jump); if (p) openReader(p.workId, p.pos); return; }
  if (d.delphrase) { S.phrases = S.phrases.filter(x => x.id !== d.delphrase); save(); return render(); }
  switch (d.act) {
    case "close-detail": $("#detail").hidden = true; detailId = null; return render();
    case "close-reader": return closeReader();
    case "close-sheet": return closeSheet();
    case "reader-style": return openStyleSheet();
    case "summary": if (plainCache) openSummary(); return;
    case "finish": { const s = S.shelf[readingId]; s.status = "finished"; s.progress = 1; save(); updateProgress(); toast("読了にしました"); if (!s.rating) openRate(); return; }
    case "sel-lookup": { const s = selectionInfo() || lastSel; if (s) lookup(s); return; }
    case "sel-save": { const s = selectionInfo() || lastSel; if (s) { savePhrase(s); getSelection().removeAllRanges(); } return; }
    case "paste": if (!$("#reader").hidden) closeReader(); return openPaste();
    case "recommend": return recommend();
    case "gen-commentary": return genCommentary();
    case "gen-critique": return genCritique();
    case "reload-catalog": return loadCatalog(true);
    case "ai-test": return aiTest();
    case "reset-ask": $("#reset-area").innerHTML = `<div class="row" style="flex-wrap:wrap"><span class="hint">本棚・ことば・保存した本文・APIキーがすべて消えます。</span><button class="btn small" data-act="reset-do" style="color:var(--danger)">消去する</button><button class="btn small" data-act="reset-cancel">やめる</button></div>`; return;
    case "reset-cancel": return render();
    case "reset-do": try { localStorage.removeItem(KEY); } catch (e) {} idb.clear().then(() => location.reload()); return;
  }
});
async function aiTest() {
  const out = $("#ai-test-out");
  out.innerHTML = '<div class="thinking">接続を確認中…</div>';
  try { const r = await callAI("「羅生門」の作者名だけを答えてください。", { maxTokens: 50 }); out.textContent = `接続できました（応答：${r.slice(0, 30)}）`; }
  catch (e) { out.innerHTML = `<span style="color:var(--danger)">${esc(aiError(e))}</span>`; }
}
document.addEventListener("change", e => {
  if (e.target.id === "status-sel") {
    const v = e.target.value, w = workOf(detailId);
    if (!v) delete S.shelf[detailId]; else ensureShelf(w, v).status = v;
    if (v === "finished") S.shelf[detailId].progress = 1;
    save(); renderDetail();
  }
});
document.addEventListener("input", e => {
  const id = e.target.id;
  if (id === "q") { searchQ = e.target.value; clearTimeout(window._qt); window._qt = setTimeout(() => { $("#results").innerHTML = searchResults(); }, 200); }
  if (id === "pq") { phraseQ = e.target.value; const pos = e.target.selectionStart; render(); const el = $("#pq"); el.focus(); el.setSelectionRange(pos, pos); }
  if (id === "ai-key") { S.aiKeys[S.aiProvider] = e.target.value.trim(); save(); }
  if (id === "ai-model") { S.aiModels[S.aiProvider] = e.target.value.trim(); save(); }
  if (id === "cinii") { S.ciniiAppId = e.target.value.trim(); save(); }
});
$("#page").addEventListener("scroll", () => requestAnimationFrame(updateProgress), { passive: true });
["mousedown", "pointerdown"].forEach(ev => $("#selbar").addEventListener(ev, e => e.preventDefault()));
$("#sheet-wrap").addEventListener("click", e => { if (e.target.id === "sheet-wrap") closeSheet(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if (!$("#sheet-wrap").hidden) closeSheet(); else if (!$("#reader").hidden) closeReader(); else if (!$("#detail").hidden) { $("#detail").hidden = true; render(); } }
  if (!$("#reader").hidden && $("#sheet-wrap").hidden && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const p = $("#page"), step = S.reader.vertical ? p.clientWidth - 48 : p.clientHeight - 60, fwd = e.key === "ArrowLeft";
    if (S.reader.vertical) p.scrollBy({ left: fwd ? -step : step, behavior: "smooth" }); else p.scrollBy({ top: fwd ? step : -step, behavior: "smooth" });
  }
});

/* 起動 */
render();
loadCatalog();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
