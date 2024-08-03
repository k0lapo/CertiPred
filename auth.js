const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const csv = require('csv-parser');

// Replace with your bot token
const token = process.env.TELEGRAM_BOT_TOKEN || '7081665166:AAFu_plP2tEFqXDjVzO-llEvvRd10XJr3C8';
const bot = new TelegramBot(token, { polling: true });

// Replace with your Telegram group chat ID
const groupId = process.env.TELEGRAM_GROUP_ID || '-4205334594';

// Load allowed usernames from CSV
let allowedUsernames = [];

fs.createReadStream('allowed_users.csv')
  .pipe(csv())
  .on('data', (row) => {
    allowedUsernames.push(row.username);
  })
  .on('end', () => {
    console.log('CSV file successfully processed');
  });

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

  await bot.sendMessage(message.chat.id, 'Choose a payment option.');
  await bot.sendMessage(
    message.chat.id,
    'Getting payment providers for your country, please wait.'
  );
  await bot.sendMessage(
    message.chat.id,
    'The price for VIP subscription is N50,000 for 30 days...'
  );

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

// Listen for '/join vip' command
bot.onText(/\/join vip (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const resp = match[1];
  bot.sendMessage(chatId, `You said: ${resp}`);
});

// Function to remove members not in the allowed list

fs.createReadStream('allowed_users.csv')
  .pipe(csv())
  .on('data', (row) => {
    allowedUsernames.push(row.username.toLowerCase());
  })
  .on('end', () => {
    console.log('CSV file successfully processed');
  });

// Function to remove members not in the allowed list

// Function to remove members not in the allowed list
// const removeUnauthorizedMembers = async () => {
//     try {
//       const chatMembers = await bot.getChatAdministrators(groupId); // Start with admins (this includes creator and admins)
  
//       // Loop through each admin and kick if not in allowedUsernames
//       for (let admin of chatMembers) {
//         const userId = admin.user.id;
//         const username = admin.user.username ? admin.user.username.toLowerCase() : '';
  
//         if (username && !allowedUsernames.includes(username)) {
//           // If the username is not in the allowed list, kick the user
//           await bot.kickChatMember(groupId, userId);
//           console.log(`Removed admin: ${username}`);
//         }
//       }
  
//       // Retrieve and loop through each member (that is not an admin)
//       const totalMembersCount = await bot.getChatMembersCount(groupId);
//       for (let i = 0; i < totalMembersCount; i++) {
//         const member = await bot.getChatMember(groupId, i);
//         const userId = member.user.id;
//         const username = member.user.username ? member.user.username.toLowerCase() : '';
  
//         // Skip if no username or the user is in the allowed list
//         if (!username || allowedUsernames.includes(username)) {
//           continue;
//         }
  
//         // Skip if the user is an administrator or the creator
//         if (member.status === 'administrator' || member.status === 'creator') {
//           continue;
//         }
  
//         // Kick out the user
//         await bot.kickChatMember(groupId, userId);
//         console.log(`Removed user: ${username}`);
//       }
//     } catch (error) {
//       console.error('Error removing members:', error);
//     }
//   };

// Function to remove members not in the allowed list
const removeUnauthorizedMembers = async () => {
    try {
      const chatMembersCount = await bot.getChatMemberCount(groupId);
      console.log(`Total members: ${chatMembersCount}`);
  
      for (let i = 0; i < chatMembersCount; i++) {
        const member = await bot.getChatMember(groupId, i);
        const username = member.user.username ? member.user.username.toLowerCase() : '';
        console.log(member)
        console.log(username)
        // Skip if no username or the user is in the allowed list
        if (!username || allowedUsernames.includes(username)) {
          continue;
        }
  
        // Skip if the user is an administrator or the creator
        if (member.status === 'administrator' || member.status === 'creator') {
          continue;
        }
  
        console.log(member.user.id)
        // Ban the user
        await bot.banChatMember(groupId, member.user.id);

        console.log(`Removed user: ${username}`);
      }
    } catch (error) {
      console.error('Error removing members:', error);
    }
  };

// Schedule to check and remove unauthorized members periodically
setInterval(removeUnauthorizedMembers, 3600000); // Runs every 1 hour
removeUnauthorizedMembers()

// Optionally, log non-command messages for debugging
// bot.on('message', (msg) => {
//   if (msg.text.startsWith('/')) {
//     // This is a command message, let it pass
//   } else {
//     // Ignore other non-command messages
//   }
// });
