const TelegramBot = require('node-telegram-bot-api');

// Replace with your bot token
const token =
  process.env.TELEGRAM_BOT_TOKEN ||
  '7423465518:AAE9PLXR0teojJXrZZSXY7n1boqk58IDeDQ';

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

// Listen for '/start' command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Welcome, kindly use the MENU to send a chat to the Bot, or type the /subscribe command to subscribe to the VIP group'
  );
});

// Listen for '/subscribe' command
bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Thanks for considering our VIP subscription. First, which country are you paying from?',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Nigeria', callback_data: 'nigeria' }],
          [{ text: 'Ghana', callback_data: 'ghana' }],
          [{ text: 'Brazil', callback_data: 'brazil' }],
          [{ text: 'Uganda', callback_data: 'uganda' }],
          [{ text: 'Tanzania', callback_data: 'tanzania' }],
          [{ text: 'Zambia', callback_data: 'zambia' }],
        ],
      },
    }
  );
});

// Handle button clicks
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;

  await bot.answerCallbackQuery(callbackQuery.id);
  await bot.sendMessage(message.chat.id, `You selected: ${data}`);

  // Sending subsequent messages
  await bot.sendMessage(message.chat.id, 'Choose a payment option.');
  await bot.sendMessage(
    message.chat.id,
    'Getting payment providers for your country, please wait.'
  );
  await bot.sendMessage(
    message.chat.id,
    'The price for VIP subscription is N50,000 for 30 days...'
  );

  // Sending the "Pay now" button
  await bot.sendMessage(
    message.chat.id,
    'Please click "Pay now" to proceed with payment.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Pay now', url: 'https://paystack.com/pay/certipred' }],
        ],
      },
    }
  );
});

// Listen for other commands
bot.onText(/\/join vip (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const resp = match[1]; // the captured "whatever"
  bot.sendMessage(chatId, `You said: ${resp}`);
});





// // Optionally, log non-command messages for debugging
// bot.on('message', (msg) => {
//   if (msg.text.startsWith('/')) {
//     // This is a command message, let it pass
//   } else {
//     // Ignore other non-command messages
//   }
// });
