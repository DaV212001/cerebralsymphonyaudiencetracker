const { handleCommand } = require("./commands");
const { handleMyChatMember, handleChatMember } = require("./events");

async function handleUpdate(update) {
  const msg = update.message?.text;
  const user = update.message?.from;

  if (msg && user) {
    return handleCommand(msg, user);
  }

  if (update.my_chat_member) {
    return handleMyChatMember(update);
  }

  if (update.chat_member) {
    return handleChatMember(update);
  }
}

module.exports = {
  handleUpdate,
};
