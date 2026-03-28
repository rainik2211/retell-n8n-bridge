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
    ws.send(JSON.stringify({
      response_type: "response",
      response_id: responseId,
      content: text,
      content_complete: true,
      end_call: endCall,
    }));
    console.log("[Bridge] -> Retell:", text.substring(0, 120));
  }

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const type = msg.interaction_type;
    console.log("[Bridge] Event:", type);

    if (msg.call?.call_id) callId = msg.call.call_id;

    if (msg.transcript?.length) {
      transcript = msg.transcript.map((t) => `${t.role}: ${t.content}`).join("\n");
    }

    if (type === "ping_pong") {
      ws.send(JSON.stringify({ interaction_type: "ping_pong" }));
      return;
    }

    // Instant greeting on call start
    if (type === "call_details" && !greetingSent) {
      greetingSent = true;
      setTimeout(() => send(GREETING), 300);
      return;
    }

    if (type === "response_required" || type === "reminder_required") {
      console.log("[Bridge] Transcript:\n", transcript);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);

        const res = await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            call_id: callId,
            phone_number: "",
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

        send(text || "Could you please repeat that?");

      } catch (err) {
        console.error("[Bridge] Error:", err.message);
        send(err.name === "AbortError"
          ? "I'm still looking that up, just a moment."
          : "Could you please repeat that?"
        );
      }
    }
  });

  ws.on("close", () => console.log("[Bridge] Ended:", callId));
  ws.on("error", (err) => console.error("[Bridge] WS error:", err.message));
});

server.listen(PORT, () => {
  console.log("[Bridge] Running on port " + PORT);
  console.log("[Bridge] n8n:", N8N_WEBHOOK_URL);
});
