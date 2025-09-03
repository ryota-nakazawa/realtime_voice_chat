// server.js
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { readFile } from "fs/promises";

dotenv.config();

// Polyfill fetch for Node < 18
if (typeof fetch === "undefined") {
  const { default: nodeFetch } = await import("node-fetch");
  globalThis.fetch = nodeFetch;
}

const {
  OPENAI_API_KEY,
  PORT = 3000,
  REALTIME_MODEL = "gpt-realtime",       // 旧: gpt-4o-realtime-preview でも可
  REALTIME_VOICE = "alloy",
  TRANSCRIBE_MODEL = "gpt-4o-transcribe",
  TURN_SILENCE_MS = "700",
  CORS_ALLOW_ORIGIN = ""                 // 本番は正確に指定: 例 "https://your.app"
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// --- Optional middlewares（未導入でも動きます） ---
try {
  const { default: helmet } = await import("helmet");
  app.use(helmet({ contentSecurityPolicy: false }));
} catch (_) {}

try {
  const { default: cors } = await import("cors");
  app.use(cors({
    origin: (origin, cb) => {
      if (!CORS_ALLOW_ORIGIN) return cb(null, true); // 開発はフリー
      const allowed = CORS_ALLOW_ORIGIN.split(",").map(s => s.trim());
      if (!origin || allowed.includes(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: true
  }));
} catch (_) {}

try {
  const { rateLimit } = await import("express-rate-limit");
  app.use("/token", rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, slow down." }
  }));
} catch (_) {}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

// --- Ephemeral session issuing ---
app.post("/token", async (_req, res) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const body = {
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      modalities: ["audio", "text"],
      turn_detection: { type: "server_vad", silence_duration_ms: Number(TURN_SILENCE_MS) || 700 },
      input_audio_transcription: { model: TRANSCRIBE_MODEL },
      // Realtime Function Calling: get_weather, search_kb を定義
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "指定された都市の現在の天気(気温と簡易天気)を返す",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "都市名（日本語可）" },
              unit: { type: "string", enum: ["c", "f"], default: "c" }
            },
            required: ["city"]
          }
        },
        {
          type: "function",
          name: "search_kb",
          description: "ナレッジベースから関連情報を検索して要約を返す",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "検索クエリ（日本語可）" },
              top_k: { type: "integer", minimum: 1, maximum: 10, default: 5 }
            },
            required: ["query"]
          }
        }
      ],
      // セッション全体の方針: 知識質問は必ず search_kb を使用
      instructions: "あなたは親切な音声アシスタントです。原則日本語で簡潔に回答します。一般知識・技術解説・定義・事実確認などの『知識質問』に回答する前に必ず一度 search_kb 関数を呼び出し、上位ヒットの要点を統合して回答してください。最低1件の出典（タイトルとURL）を短く明示します。天気の質問は get_weather を使用します。ヒットが0件のときはその旨を伝え、質問の絞り込みを促してください。推測やハルシネーションは避けてください。"
    };

    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timer);
    const text = await r.text();
    if (!r.ok) {
      return jsonError(res, 502, "Failed to create ephemeral session", {
        upStatus: r.status, detail: text.slice(0, 1024)
      });
    }
    try {
      const data = JSON.parse(text);
      return res.json(data);
    } catch {
      return jsonError(res, 502, "Upstream returned non-JSON", { body: text.slice(0, 1024) });
    }
  } catch (err) {
    const msg = (err && err.name === "AbortError") ? "Upstream timeout" : (err?.message || String(err));
    return jsonError(res, 500, "Token endpoint error", { detail: msg });
  }
});

// --- Static hosting (public/index.html 他) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (_req, res) => res.json({ ok: true, model: REALTIME_MODEL }));

// --- Simple RAG search endpoint (keyword-based) ---
let KB_CACHE = null;
const RAG_STATS = { total: 0, recent: [] }; // simple in-memory stats
async function loadKB() {
  if (KB_CACHE) return KB_CACHE;
  try {
    const p = path.join(__dirname, "kb", "sample_kb.json");
    const raw = await readFile(p, "utf8");
    KB_CACHE = JSON.parse(raw);
  } catch (err) {
    console.warn("KB load failed:", err?.message || err);
    KB_CACHE = [];
  }
  return KB_CACHE;
}

function tokenize(s = "") {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length >= 2);
}

function countOccurrences(text, word) {
  if (!text || !word) return 0;
  const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return (text.match(re) || []).length;
}

function scoreDoc(doc, qTokens) {
  const title = doc.title || "";
  const tags = Array.isArray(doc.tags) ? doc.tags.join(" ") : String(doc.tags || "");
  const content = doc.content || "";
  let score = 0;
  for (const t of qTokens) {
    score += 3 * countOccurrences(title, t);
    score += 2 * countOccurrences(tags, t);
    score += 1 * countOccurrences(content, t);
  }
  return score;
}

function makeSnippet(content = "", qTokens = [], radius = 80) {
  if (!content) return "";
  let idx = -1;
  for (const t of qTokens) {
    const i = content.toLowerCase().indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return content.slice(0, radius * 2) + (content.length > radius * 2 ? "…" : "");
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end) + suffix;
}

app.post("/rag/search", async (req, res) => {
  try {
    const { query = "", top_k = 5 } = req.body || {};
    const q = String(query || "").trim();
    if (!q) return jsonError(res, 400, "Missing 'query'");
    const topK = Math.max(1, Math.min(10, Number(top_k) || 5));

    const kb = await loadKB();
    const qTokens = tokenize(q);
    const scored = kb.map(doc => ({
      doc,
      score: scoreDoc(doc, qTokens)
    })).filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(x => ({
        id: x.doc.id,
        title: x.doc.title,
        url: x.doc.url,
        score: x.score,
        snippet: makeSnippet(x.doc.content, qTokens),
        tags: x.doc.tags
      }));

    // record stats (in-memory)
    try {
      RAG_STATS.total += 1;
      RAG_STATS.recent.unshift({
        ts: new Date().toISOString(),
        query: q,
        top_k: topK,
        hit_count: scored.length,
        ua: req.headers["user-agent"] || ""
      });
      if (RAG_STATS.recent.length > 50) RAG_STATS.recent.length = 50;
    } catch {}

    return res.json({ results: scored, query: q, top_k: topK });
  } catch (err) {
    return jsonError(res, 500, "RAG search error", { detail: err?.message || String(err) });
  }
});

// --- RAG stats endpoints (for curl verification) ---
app.get("/rag/stats", (_req, res) => {
  res.json({
    total: RAG_STATS.total,
    recent: RAG_STATS.recent
  });
});

app.post("/rag/stats/reset", (_req, res) => {
  RAG_STATS.total = 0;
  RAG_STATS.recent = [];
  res.json({ ok: true });
});

app.listen(Number(PORT), () => {
  console.log(`✅ Realtime helper listening: http://localhost:${PORT}`);
});
