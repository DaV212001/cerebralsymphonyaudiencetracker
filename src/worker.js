const { supabase } = require("./config");
const { flushDueBatches } = require("./services/batches");
const { handleUpdate } = require("./handlers");
const { err } = require("./utils/logger");

async function claimBatch() {
  const { data } = await supabase
    .from("event_queue")
    .select("*")
    .eq("status", "pending")
    .lte("next_retry_at", new Date().toISOString())
    .limit(10);

  if (!data?.length) return [];

  await supabase
    .from("event_queue")
    .update({
      status: "processing",
      locked_at: new Date().toISOString(),
    })
    .in("id", data.map((d) => d.id));

  return data;
}

let running = false;

async function worker() {
  if (running) return;
  running = true;

  try {
    await flushDueBatches();

    const items = await claimBatch();

    if (!items.length) {
      running = false;
      return setTimeout(worker, 1200);
    }

    await Promise.allSettled(
      items.map(async (item) => {
        try {
          await handleUpdate(item.payload);

          await supabase
            .from("event_queue")
            .update({ status: "done" })
            .eq("id", item.id);
        } catch (e) {
          const retry = (item.retry_count || 0) + 1;

          await supabase
            .from("event_queue")
            .update({
              status: retry >= 5 ? "dead" : "pending",
              retry_count: retry,
              next_retry_at: new Date(
                Date.now() + Math.min(60000 * retry, 900000)
              ).toISOString(),
            })
            .eq("id", item.id);

          err("retry:", item.update_id, retry, e.message);
        }
      })
    );
  } catch (e) {
    err("worker crash:", e.message);
  }

  running = false;
  setTimeout(worker, 800);
}

function startWorker() {
  worker();
}

module.exports = {
  startWorker,
};
