const { PORT } = require("./src/config");
const { app } = require("./src/app");
const { startWorker } = require("./src/worker");
const { setBotCommands, ensureWebhook } = require("./src/services/telegram");
const { log } = require("./src/utils/logger");

app.listen(PORT, () => {
  log(`🚀 ChannelSubTracker running on port ${PORT}`);
  startWorker();
  log("⚙️ Event queue worker running");
  setBotCommands().catch(() => {});
  ensureWebhook().catch(() => {});
});
