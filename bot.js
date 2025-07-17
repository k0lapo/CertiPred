const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const csv = require('csv-parser');
const crypto = require('crypto');
const { parse } = require('json2csv');
const axios = require('axios');
const lockfile = require('proper-lockfile');
const schedule = require('node-schedule');
require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.RENDER_APP_URL;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const tronGridApiKey = process.env.TRONGRID_API_KEY;
const VIP_GROUP_CHAT_ID = process.env.VIP_GROUP_CHAT_ID;
const csvFilePath = 'users.csv';

const VIP_GROUP_URL = 'https://t.me/+2AsqyFrMUgUwYjM0';
const GHANA_PRICE = 1 * 100;
const NIGERIA_PRICE = 100 * 100;
const CURRENCY_MAP = { nigeria: 'NGN', ghana: 'GHS' };

const bot = new TelegramBot(token, { webHook: true });
bot.setWebHook(`${url}/bot${token}`);

const app = express();
app.use(bodyParser.json());

if (!fs.existsSync(csvFilePath)) {
  fs.writeFileSync(
    csvFilePath,
    'id,username,first_name,last_name,email,status,payment_reference,subscription_start\n'
  );
}

app.get('/users.csv', (req, res) => {
  res.sendFile(path.join(__dirname, csvFilePath));
});

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post('/paystack/webhook', (req, res) => {
  const hash = crypto
    .createHmac('sha512', paystackSecretKey)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash === req.headers['x-paystack-signature']) {
    const { event, data } = req.body;
    if (event === 'charge.success') {
      const email = data.customer.email;
      const reference = data.reference;
      readUsersFromCSV().then((users) => {
        const userIndex = users.findIndex(
          (u) => u.email === email && u.payment_reference === reference
        );
        if (userIndex !== -1) {
          const user = users[userIndex];
          user.status = 'true';
          user.subscription_start = new Date().toISOString();
          writeUsersToCSV(users);
          bot.sendMessage(
            user.id,
            `✅ Payment confirmed! Your VIP subscription is now active.`
          );
          bot.sendMessage(user.id, `Click below to join the VIP group:`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Join VIP Group', url: VIP_GROUP_URL }],
              ],
            },
          });
        }
      });
    }
  }
  res.sendStatus(200);
});

function readUsersFromCSV() {
  return new Promise((resolve, reject) => {
    const users = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => users.push(row))
      .on('end', () => resolve(users))
      .on('error', reject);
  });
}

function writeUsersToCSV(users) {
  lockfile
    .lock(csvFilePath, { retries: 3 })
    .then((release) => {
      fs.writeFileSync(csvFilePath, parse(users, { header: true }));
      release();
    })
    .catch(console.error);
}

async function manageSubscriptionExpirations() {
  const currentDate = new Date();
  const users = await readUsersFromCSV();
  let updated = false;
  for (let user of users) {
    if (!user.subscription_start || user.status !== 'true') continue;
    const subscriptionStart = new Date(user.subscription_start);
    const daysDiff = Math.floor(
      (currentDate - subscriptionStart) / (1000 * 60 * 60 * 24)
    );
    if (daysDiff === 25) {
      bot.sendMessage(user.id, `⏳ Your VIP subscription expires in 5 days.`);
    } else if (daysDiff === 29) {
      bot.sendMessage(user.id, `⚠️ Your VIP subscription expires tomorrow.`);
    } else if (daysDiff >= 30) {
      try {
        await bot.banChatMember(VIP_GROUP_CHAT_ID, user.id);
        await bot.unbanChatMember(VIP_GROUP_CHAT_ID, user.id);
        bot.sendMessage(
          user.id,
          `🚫 Subscription expired. You have been removed.`
        );
        user.status = 'false';
        updated = true;
      } catch (err) {
        console.error(`Error removing user ${user.id}:`, err.message);
      }
    }
  }
  if (updated) writeUsersToCSV(users);
}

bot.onText(/\/status/, async (msg) => {
  const user = (await readUsersFromCSV()).find(
    (u) => u.id === String(msg.chat.id)
  );
  if (!user || user.status !== 'true')
    return bot.sendMessage(msg.chat.id, '❌ Not an active VIP member.');
  const expiry = new Date(user.subscription_start);
  expiry.setDate(expiry.getDate() + 30);
  const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
  bot.sendMessage(
    msg.chat.id,
    `✅ VIP active\nExpires in: ${daysLeft} day(s)\nDate: ${expiry.toDateString()}`
  );
});

bot.onText(/\/renew/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await readUsersFromCSV();
  const user = users.find((u) => u.id === String(chatId));
  if (!user) return bot.sendMessage(chatId, '❌ Not registered. Use /start.');
  bot.sendMessage(chatId, 'Select payment method to renew:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🇳🇬 Naira (Paystack)', callback_data: 'renew_nigeria' }],
        [{ text: '💱 USDT (Crypto)', callback_data: 'crypto' }],
      ],
    },
  });
});

bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;

  console.log('Callback query received:', data); // Debugging log

  await bot.answerCallbackQuery(callbackQuery.id);

  const users = await readUsersFromCSV();
  const userIndex = users.findIndex((u) => u.id === String(message.chat.id));
  if (userIndex === -1) {
    return bot.sendMessage(
      message.chat.id,
      '❌ User not found. Please register first.'
    );
  }

  const user = users[userIndex];

  if (data === 'ghana' || data === 'nigeria') {
    const amount = data === 'ghana' ? GHANA_PRICE : NIGERIA_PRICE;
    const currency =
      data === 'ghana' ? CURRENCY_MAP.ghana : CURRENCY_MAP.nigeria;

    // Generate a unique payment reference
    const paymentReference = generatePaymentReference();
    user.payment_reference = paymentReference;
    users[userIndex] = user;
    writeUsersToCSV(users);

    // Initialize Paystack payment
    try {
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount,
          currency,
          reference: paymentReference,
        },
        {
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const paymentUrl = response.data.data.authorization_url;
      bot.sendMessage(
        message.chat.id,
        `💳 The price is ${amount / 100} ${currency}. Click below to pay:`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]],
          },
        }
      );
    } catch (error) {
      console.error('Payment initialization error:', error.message);
      bot.sendMessage(
        message.chat.id,
        '❌ Payment initialization failed. Please try again later.'
      );
    }
  }
});

bot.onText(/\/crypto/, (msg) => {
  const chatId = msg.chat.id;
  const paymentAmount = 32;
  const yourTRC20Wallet = 'TMuVT2cUkxRUxatHhUYKcBV7c5vDarm1PE';
  bot.sendMessage(
    chatId,
    `🔐 *Crypto Payment - USDT (TRC-20)*\n\nPlease send *${paymentAmount} USDT* to:\n\`${yourTRC20Wallet}\`\n\nReply with the *TXID* to verify.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^[a-fA-F0-9]{64}$/, async (msg) => {
  const chatId = msg.chat.id;
  const txid = msg.text;
  const users = await readUsersFromCSV();
  const userIndex = users.findIndex((u) => u.id === String(chatId));
  if (userIndex === -1) return;
  const user = users[userIndex];
  if (user.payment_reference.includes(txid))
    return bot.sendMessage(chatId, '❗ TXID already used.');
  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/transactions/${txid}`,
      {
        headers: { 'TRON-PRO-API-KEY': tronGridApiKey },
      }
    );
    const tx = res.data.data[0];
    if (tx && tx.ret[0].contractRet === 'SUCCESS') {
      const amount =
        parseInt(tx.raw_data.contract[0].parameter.value.data, 16) / 1e6;
      const expectedReceiver = '417b62c8d47c6a5353e03a01d81d5c4e3d3fa0cf15';
      const to = tx.raw_data.contract[0].parameter.value.contract_address;
      if (to.toLowerCase() === expectedReceiver.toLowerCase() && amount >= 32) {
        user.status = 'true';
        user.subscription_start = new Date().toISOString();
        user.payment_reference = `USDT-${txid}`;
        users[userIndex] = user;
        writeUsersToCSV(users);
        bot.sendMessage(chatId, `✅ Payment confirmed! Welcome to VIP.`);
        bot.sendMessage(chatId, `Click below to join:`, {
          reply_markup: {
            inline_keyboard: [[{ text: 'Join VIP Group', url: VIP_GROUP_URL }]],
          },
        });
      } else {
        bot.sendMessage(chatId, '⚠️ Payment validation failed.');
      }
    } else {
      bot.sendMessage(chatId, '❌ Invalid or failed transaction.');
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Error verifying transaction.');
  }
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot
    .sendPhoto(chatId, 'TC.png', {
      caption: 'Please read the terms and conditions.',
    })
    .then(() => bot.sendMessage(chatId, 'Please provide your email address:'));
  bot.once('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
      const email = msg.text;
      const user = {
        id: msg.from.id,
        username: msg.from.username || '',
        first_name: msg.from.first_name || '',
        last_name: msg.from.last_name || '',
        email,
        status: 'false',
        payment_reference: '',
        subscription_start: '',
      };
      readUsersFromCSV().then((users) => {
        const exists = users.some((u) => u.id === String(user.id));
        if (!exists) {
          users.push(user);
          writeUsersToCSV(users);
          bot.sendMessage(
            chatId,
            'You have been registered. Click /subscribe.'
          );
        } else {
          bot.sendMessage(chatId, 'Welcome back. Click /subscribe.');
        }
      });
    } else {
      bot.sendMessage(chatId, 'Invalid email. Use /start again.');
    }
  });
});

bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Where are you paying from?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Nigeria', callback_data: 'nigeria' }],
        [{ text: 'Ghana', callback_data: 'ghana' }],
      ],
    },
  });
});

// async function handlePaymentReference(userId, user, isRenewal = false) {
//   const paymentReference = generatePaymentReference();

//   // Store the new payment reference
//   user.payment_reference = paymentReference;

//   // NOTE: We no longer activate or set subscription_start here.
//   const users = await readUsersFromCSV();
//   const updatedUsers = users.map((u) => (u.id === String(userId) ? user : u));
//   writeUsersToCSV(updatedUsers);

//   // Notify the user that payment link has been generated
//   bot.sendMessage(
//     userId,
//     `💳 Payment link generated.\n\nPlease complete the payment to activate your ${
//       isRenewal ? 'renewal' : 'subscription'
//     }.`
//   );
// }

function generatePaymentReference() {
  return `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

schedule.scheduleJob('0 0 * * *', manageSubscriptionExpirations);

app.get('/', (req, res) => {
  res.send('Bot is live and running.');
});

app.listen(process.env.PORT || 3001, () => {
  console.log(
    `✅ Express server listening on port ${process.env.PORT || 3001}`
  );
});
