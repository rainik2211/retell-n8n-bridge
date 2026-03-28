const WebSocket = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 8080;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://rainiksoni.app.n8n.cloud/webhook/retell-inbound";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", bridge: "retell-n8n" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  console.log("[Bridge] Retell connected");

  let responseId = 0;
  let callId = null;
  let transcript = "";

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.error("[Bridge] Failed to parse message:", e);
      return;
    }

    console.log("[Bridge] Event:", msg.interaction_type);

    if (msg.call && msg.call.call_id) {
      callId = msg.call.call_id;
    }

    if (msg.interaction_type === "ping_pong") {
      ws.send(JSON.stringify({ interaction_type: "ping_pong" }));
      return;
    }

    if (msg.interaction_type === "call_details") {
      return;
    }

    if (msg.interaction_type === "update_only") {
      if (msg.transcript) {
        transcript = msg.transcript.map((t) => `${t.role}: ${t.content}`).join("\n");
      }
      return;
    }

    if (msg.interaction_type === "response_required" || msg.interaction_type === "reminder_required") {
      if (msg.transcript) {
        transcript = msg.transcript.map((t) => `${t.role}: ${t.content}`).join("\n");
      }

      responseId++;

      const phoneMatch = transcript.match(/\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      const phone = phoneMatch ? phoneMatch[0].replace(/\D/g, "") : "";
      const formattedPhone = phone.length === 10 ? "+1" + phone : phone.length === 11 ? "+" + phone : "";

      try {
        const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            call_id: callId,
            interaction_type: msg.interaction_type,
            response_id: responseId,
            transcript: transcript,
            phone_number: formattedPhone,
            email_id: "",
            conversation_transcript: transcript,
          }),
        });

        if (!n8nResponse.ok) {
          throw new Error("n8n returned " + n8nResponse.status);
        }

        const n8nData = await n8nResponse.json();

        const responseText =
          n8nData.response ||
          n8nData.output_response ||
          n8nData.content ||
          "I'm sorry, I had trouble processing that. Could you please repeat?";

        ws.send(JSON.stringify({
          response_type: "response",
          response_id: responseId,
          content: responseText,
          content_complete: true,
          end_call: false,
        }));

        console.log("[Bridge] Sent:", responseText.substring(0, 80));

      } catch (err) {
        console.error("[Bridge] Error:", err.message);

        ws.send(JSON.stringify({
          response_type: "response",
          response_id: responseId,
          content: "I'm experiencing a technical issue. Please hold for a moment.",
          content_complete: true,
          end_call: false,
        }));
      }
    }
  });

  ws.on("close", () => {
    console.log("[Bridge] Call ended:", callId);
  });

  ws.on("error", (err) => {
    console.error("[Bridge] WebSocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log("[Bridge] Running on port " + PORT);
  console.log("[Bridge] Forwarding to: " + N8N_WEBHOOK_URL);
});
