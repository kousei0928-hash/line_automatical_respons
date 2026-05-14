import crypto from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction:
    "あなたは丁寧で親しみやすい日本語のカスタマーサポートです。回答は300文字以内で簡潔にまとめてください。",
});

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let buf = Buffer.concat(chunks);

  if (buf.length === 0 && req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      buf = req.body;
    } else if (typeof req.body === "string") {
      buf = Buffer.from(req.body, "utf8");
    } else if (typeof req.body === "object") {
      buf = Buffer.from(JSON.stringify(req.body), "utf8");
    }
  }
  return buf;
}

function verifySignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  console.log("[DEBUG] secret length:", LINE_CHANNEL_SECRET?.length);
  console.log("[DEBUG] secret head:", LINE_CHANNEL_SECRET?.slice(0, 4));
  console.log("[DEBUG] body length:", rawBody.length);
  console.log("[DEBUG] expected sig:", expected);
  console.log("[DEBUG] received sig:", signature);
  console.log("[DEBUG] match:", expected === signature);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature ?? ""));
  } catch {
    return false;
  }
}

async function generateReply(userText) {
  const result = await model.generateContent(userText);
  return result.response.text().trim() || "うまく回答が作れませんでした。";
}

async function replyToLine(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
  if (!res.ok) {
    console.error("LINE reply failed", res.status, await res.text());
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"];
  if (!verifySignature(rawBody, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const body = JSON.parse(rawBody.toString("utf8"));
  const events = body.events ?? [];

  console.log("[DEBUG] events count:", events.length);

  await Promise.all(
    events.map(async (event, i) => {
      console.log(`[DEBUG] event[${i}] type:`, event.type, "msg type:", event.message?.type);
      if (event.type !== "message" || event.message?.type !== "text") return;
      try {
        console.log(`[DEBUG] calling Gemini for:`, event.message.text);
        const reply = await generateReply(event.message.text);
        console.log(`[DEBUG] Gemini reply (length ${reply.length}):`, reply.slice(0, 60));
        await replyToLine(event.replyToken, reply);
        console.log(`[DEBUG] reply sent to LINE`);
      } catch (err) {
        console.error("handler error", err);
        await replyToLine(event.replyToken, "申し訳ありません、応答の生成に失敗しました。");
      }
    }),
  );

  res.status(200).send("OK");
}
