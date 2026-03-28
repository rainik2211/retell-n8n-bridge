const WebSocket = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 8080;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://rainiksoni.app.n8n.cloud/webhook/retell-inbound";

const server = http.createCreate((req, res) => {
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
  console.log(`[Bridge] Retell connected: ${req.url}`);

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

    console.log(`[Bridge] Received event: ${msg.interaction_type}`);

    // Extract call ID from first message
    if (msg.call && msg.call.call_id) {
      callId = msg.call.call_id;
    }

    // Handle different Retell event types
    if (
      msg.interaction_type === "call_details" ||
      msg.interaction_type === "ping_pong"
    ) {
      // Acknowledge ping
      if (msg.interaction_type === "ping_pong") {
        ws.send(JSON.stringify({ interaction_type: "ping_pong" }));
      }
      return;
    }

    if (msg.interaction_type === "update_only") {
      // Transcript update — store but don't respond yet
      if (msg.transcript) {
        transcript = msg.transcript
          .map((t) => `${t.role}: ${t.content}`)
          .join("\n");
      }
      return;
    }

    if (msg.interaction_type === "response_required" || msg.interaction_type === "reminder_required") {
      // Build transcript from message
      if (msg.transcript) {
        transcript = msg.transcript
          .map((t) => `${t.role}: ${t.content}`)
          .join("\n");
      }

      responseId++;

      // Extract user phone from transcript if available
      const phoneMatch = transcript.match(/\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      const phone = phoneMatch ? phoneMatch[0].replace(/\D/g, "") : "";
      const formattedPhone = phone.length === 10 ? `+1${phone}` : phone.length === 11 ? `+${phone}` : "";

      try {
        // Forward to n8n
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
          throw new Error(`n8n returned ${n8nResponse.status}`);
        }

        const n8nData = await n8nResponse.json();
        console.log(`[Bridge] n8n response:`, n8nData);

        // Extract response text
        const responseText =
          n8nData.response ||
          n8nData.output_response ||
          n8nData.content ||
          "I'm sorry, I had trouble processing that. Could you please repeat?";

        // Send back to Retell in correct WebSocket format
        const retellResponse = {
          response_type: "response",
          response_id: responseId,
          content: responseText,
          content_complete: true,
          end_call: false,
        };

        ws.send(JSON.stringify(retellResponse));
        console.log(`[Bridge] Sent to Retell: ${responseText.substring(0, 80)}...`);

      } catch (err) {
        console.error("[Bridge] Error calling n8n:", err);

        // Send fallback response so call doesn't drop
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
    console.log(`[Bridge] Call ended: ${callId}`);
  });

  ws.on("error", (err) => {
    console.error("[Bridge] WebSocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`[Bridge] Running on port ${PORT}`);
  console.log(`[Bridge] Forwarding to: ${N8N_WEBHOOK_URL}`);
});