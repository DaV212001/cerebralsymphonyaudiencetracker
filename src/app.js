const express = require("express");
const { supabase } = require("./config");
const { err } = require("./utils/logger");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ----------------------
// HEALTH
// ----------------------

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----------------------
// WEBHOOK
// ----------------------

app.post("/webhook", async (req, res) => {
  const update = req.body;
  res.sendStatus(200);

  if (!update?.update_id) return;

  try {
    await supabase.from("event_queue").insert({
      update_id: update.update_id,
      payload: update,
      status: "pending",
      retry_count: 0,
      next_retry_at: new Date().toISOString(),
    });
  } catch (e) {
    if (e?.code !== "23505") {
      err("Queue error:", e.message);
    }
  }
});

module.exports = { app };
