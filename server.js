const WebSocket = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 8080;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://rainiksoni.app.n8n.cloud/webhook/retell-inbound";
const GREETING = "Hi! Thank you for calling Expedia. Can I get your phone number so I can pull up your booking?";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("[Bridge] Call connected");

  let responseId = 0;
  let callId = null;
  let greetingSent = false;
  let transcript = "";

  function send(text, endCall = false) {
    responseId++;
    const msg = {
      response_type: "response",
      response_id: responseId,
      content: text,
      content_complete: true,
      end_call: endCall,
    };
    ws.send(JSON.stringify(msg));
    console.log("[Bridge] -> Retell:", text.substring(0, 120));
  }

  async function callN8n(phone) {
    console.log("[Bridge] Calling n8n with phone:", phone || "(none)");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          call_id: callId,
          phone_number: phone,
          email_id: "",
          conversation_transcript: transcript,
        }),
      });

      clearTimeout(timeout);
      const raw = await res.text();
      console.log("[Bridge] n8n response:", raw.substring(0, 300));

      let text = "";
      try {
        const parsed = JSON.parse(raw);
        text = parsed.response || parsed.output_response || parsed.content || "";
      } catch {
        text = raw.trim();
      }

      return text || null;

    } catch (err) {
      clearTimeout(timeout);
      console.error("[Bridge] n8n error:", err.message);
      return null;
    }
  }

  function extractPhone(text) {
    const match = text.match(/\+?1?\s*\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
    if (!match) return "";
    const digits = match[0].replace(/\D/g, "");
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11) return "+" + digits;
    return "";
  }

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const type = msg.interaction_type;
    console.log("[Bridge] Event:", type);

    if (msg.call?.call_id) callId = msg.call.call_id;

    // Update transcript on every event
    if (msg.transcript?.length) {
      transcript = msg.transcript.map((t) => `${t.role}: ${t.content}`).join("\n");
    }

    if (type === "ping_pong") {
      ws.send(JSON.stringify({ interaction_type: "ping_pong" }));
      return;
    }

    // Send greeting immediately when call starts
    if (type === "call_details" && !greetingSent) {
      greetingSent = true;
      setTimeout(() => send(GREETING), 500);
      return;
    }

    if (type === "response_required" || type === "reminder_required") {
      const phone = extractPhone(transcript);
      const response = await callN8n(phone);

      if (response && response.trim() !== "") {
        send(response);
      } else {
        // n8n returned nothing — run a fallback based on context
        if (!phone) {
          send("I didn't quite catch that. Could you please give me your phone number?");
        } else {
          send("I couldn't find a booking with that number. Could you double-check the number for me?");
        }
      }
    }
  });

  ws.on("close", () => console.log("[Bridge] Call ended:", callId));
  ws.on("error", (err) => console.error("[Bridge] WS error:", err.message));
});

server.listen(PORT, () => {
  console.log("[Bridge] Running on port " + PORT);
  console.log("[Bridge] n8n:", N8N_WEBHOOK_URL);
});
