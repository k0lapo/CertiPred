const TelegramBot = require('node-telegram-bot-api');

// Replace with your bot token
const token = process.env.TELEGRAM_BOT_TOKEN || '7423465518:AAE9PLXR0teojJXrZZSXY7n1boqk58IDeDQ';

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

// Listen for '/start' command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome! How can I assist you today?');
});

// Listen for '/help' command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Here are some commands you can use:\n/start - Start the bot\n/help - Get help'
  );
});

// Listen for other commands
bot.onText(/\/echo (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const resp = match[1]; // the captured "whatever"
  bot.sendMessage(chatId, `You said: ${resp}`);
});

bot.on('callback_query', (callbackQuery) => {
  const message = callbackQuery.message;
  bot
    .answerCallbackQuery(callbackQuery.id)
    .then(() => bot.sendMessage(message.chat.id, 'You clicked a button!'));
});

// Optionally, log non-command messages for debugging
bot.on('message', (msg) => {
  if (msg.text.startsWith('/')) {
    // This is a command message, let it pass
  } else {
    // Ignore other non-command messages
  }
});
