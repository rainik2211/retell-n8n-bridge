const WebSocket = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 8080;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://rainiksoni.app.n8n.cloud/webhook/retell-inbound";
const GREETING = "Hi! Thank you for calling Expedia. Can I get your phone number so I can pull up your booking?";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  console.log("[Bridge] New call connected");

  let responseId = 0;
  let callId = null;
  let isFirstResponse = true;
  let transcript = "";

  function sendToRetell(text, endCall = false) {
    responseId++;
    const msg = {
      response_type: "response",
      response_id: responseId,
      content: text,
      content_complete: true,
      end_call: endCall,
    };
    ws.send(JSON.stringify(msg));
    console.log("[Bridge] Sent to Retell:", text.substring(0, 100));
  }

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.error("[Bridge] Parse error:", e.message);
      return;
    }

    const type = msg.interaction_type;
    console.log("[Bridge] Event:", type);

    // Store call ID
    if (msg.call && msg.call.call_id) {
      callId = msg.call.call_id;
      console.log("[Bridge] Call ID:", callId);
    }

    // Ignore non-conversation events
    if (type === "call_details" || type === "update_only") {
      if (msg.transcript) {
        transcript = msg.transcript.map((t) => `${t.role}: ${t.content}`).join("\n");
      }
      return;
    }

    if (type === "ping_pong") {
      ws.send(JSON.stringify({ interaction_type: "ping_pong" }));
      return;
    }

    if (type === "response_required" || type === "reminder_required") {
      // Build transcript
      if (msg.transcript) {
        transcript = msg.transcript.map((t) => `${t.role}: ${t.content}`).join("\n");
      }

      console.log("[Bridge] Transcript so far:\n", transcript || "(empty)");

      // First response — send greeting immediately without hitting n8n
      if (isFirstResponse) {
        isFirstResponse = false;
        sendToRetell(GREETING);
        return;
      }

      // Extract phone from transcript
      const phoneMatch = transcript.match(/\+?1?\s*\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
      const rawPhone = phoneMatch ? phoneMatch[0].replace(/\D/g, "") : "";
      const phone = rawPhone.length === 10 ? "+1" + rawPhone : rawPhone.length === 11 ? "+" + rawPhone : "";

      console.log("[Bridge] Extracted phone:", phone || "(none yet)");

      // Call n8n
      try {
        console.log("[Bridge] Calling n8n...");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
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

        const rawText = await n8nResponse.text();
        console.log("[Bridge] n8n raw response:", rawText.substring(0, 200));

        let responseText = "";
        try {
          const parsed = JSON.parse(rawText);
          responseText = parsed.response || parsed.output_response || parsed.content || "";
        } catch (e) {
          responseText = rawText;
        }

        if (!responseText || responseText.trim() === "") {
          responseText = "I'm looking into that for you, please hold on.";
        }

        sendToRetell(responseText);

      } catch (err) {
        console.error("[Bridge] n8n call failed:", err.message);

        if (err.name === "AbortError") {
          sendToRetell("I'm still looking that up, just a moment please.");
        } else {
          sendToRetell("I had a small technical hiccup. Could you please repeat that?");
        }
      }
    }
  });

  ws.on("close", () => {
    console.log("[Bridge] Call ended:", callId);
  });

  ws.on("error", (err) => {
    console.error("[Bridge] WS error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log("[Bridge] Running on port " + PORT);
  console.log("[Bridge] n8n URL:", N8N_WEBHOOK_URL);
});
