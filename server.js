import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// 短命トークン(Ephemeral)を発行してブラウザに返す
app.post("/token", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1"
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "alloy",
        modalities: ["audio", "text"]
      })
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ error: text });
    }
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 静的配信（index.html など）
app.use(express.static("public"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
