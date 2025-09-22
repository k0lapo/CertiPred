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
const url = process.env.RENDER_APP_URL; // e.g. https://your-app.onrender.com
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const tronGridApiKey = process.env.TRONGRID_API_KEY;
const VIP_GROUP_CHAT_ID = process.env.VIP_GROUP_CHAT_ID; // numeric chat id for programmatic actions
const csvFilePath = 'users.csv';

const VIP_GROUP_URL = 'https://t.me/+2AsqyFrMUgUwYjM0';
const GHANA_PRICE = 5000 * 100; // GHS 5,000 (Paystack expects minor unit)
const NIGERIA_PRICE = 75000 * 100; // ₦75,000 -> 75,000 * 100 (naira)
const CURRENCY_MAP = { nigeria: 'NGN', ghana: 'GHS' };

if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!url)
  console.warn(
    'RENDER_APP_URL missing in .env — webhook may not set correctly'
  );

const bot = new TelegramBot(token, { webHook: true });
if (url) {
  bot.setWebHook(`${url}/webhook`);
}

const app = express();

// capture raw body for Paystack signature verification
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// ensure users.csv exists with expected header
if (!fs.existsSync(csvFilePath)) {
  fs.writeFileSync(
    csvFilePath,
    'id,username,first_name,last_name,email,status,payment_reference,subscription_start\n'
  );
}

app.get('/users.csv', (req, res) => {
  res.sendFile(path.join(__dirname, csvFilePath));
});

// Telegram webhook endpoint
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// PAYSTACK WEBHOOK
app.post('/paystack/webhook', (req, res) => {
  // Respond quickly so Paystack doesn’t retry
  res.sendStatus(200);

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      console.warn('⚠️ No x-paystack-signature header present');
      return;
    }

    const hash = crypto
      .createHmac('sha512', paystackSecretKey)
      .update(req.rawBody)
      .digest('hex');

    if (hash !== signature) {
      console.warn('❌ Paystack signature mismatch.');
      return;
    }

    const { event, data } = req.body;
    console.log('⚡ Paystack event:', event, 'ref:', data?.reference);

    if (event === 'charge.success') {
      const email = (data.customer?.email || '').toLowerCase();
      const reference = data.reference;
      const telegramId = data.metadata?.telegram_id;
      const firstName = data.metadata?.first_name || '';
      const username = data.metadata?.username || '';

      readUsersFromCSV()
        .then((users) => {
          // 🔎 Try to find by payment reference, Telegram ID, or email
          let userIndex = users.findIndex(
            (u) =>
              u.payment_reference === reference ||
              (telegramId && u.id == telegramId) ||
              (email && (u.email || '').toLowerCase() === email)
          );

          if (userIndex !== -1) {
            // ✅ Existing user → update subscription
            const user = users[userIndex];
            user.status = 'true';
            user.subscription_start = new Date().toISOString();
            user.payment_reference = reference || user.payment_reference;

            // If metadata includes Telegram info, update it too
            if (telegramId) user.id = telegramId;
            if (firstName) user.first_name = firstName;
            if (username) user.username = username;
            if (email) user.email = email;

            users[userIndex] = user;
            writeUsersToCSV(users);

            // 🎉 Notify user
            if (telegramId) {
              bot
                .sendMessage(
                  telegramId,
                  `✅ Payment confirmed!\n\nWelcome back to CertiPred VIP 🎉`
                )
                .catch(console.error);

              bot
                .sendMessage(
                  telegramId,
                  '🚀 Click below to join the VIP group:',
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: 'Join VIP Group', url: VIP_GROUP_URL }],
                      ],
                    },
                  }
                )
                .catch(console.error);
            }

            console.log(`🎉 Updated user ${user.id} for ref ${reference}`);
          } else {
            // 🆕 New user
            const newUser = {
              id: telegramId || `paystack_${Date.now()}`,
              username,
              first_name: firstName,
              last_name: '',
              email,
              status: 'true',
              payment_reference: reference,
              subscription_start: new Date().toISOString(),
            };

            users.push(newUser);
            writeUsersToCSV(users);

            console.log(`🆕 Created new user from Paystack: ${email}`);

            if (telegramId) {
              bot
                .sendMessage(
                  telegramId,
                  `✅ Payment confirmed!\n\nWelcome to CertiPred VIP 🎉`
                )
                .catch(console.error);

              bot
                .sendMessage(
                  telegramId,
                  '🚀 Click below to join the VIP group:',
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: 'Join VIP Group', url: VIP_GROUP_URL }],
                      ],
                    },
                  }
                )
                .catch(console.error);
            }
          }
        })
        .catch((err) =>
          console.error('Error reading users CSV on webhook:', err)
        );
    }
  } catch (err) {
    console.error('❌ Exception handling Paystack webhook:', err);
  }
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

const CSV_FIELDS = [
  'id',
  'username',
  'first_name',
  'last_name',
  'email',
  'status',
  'payment_reference',
  'subscription_start',
];

function readUsersFromCSV() {
  return new Promise((resolve, reject) => {
    const users = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        // Normalize each row to ensure all fields exist
        const normalized = {};
        CSV_FIELDS.forEach((field) => {
          normalized[field] = row[field] || '';
        });
        users.push(normalized);
      })
      .on('end', () => resolve(users))
      .on('error', reject);
  });
}

function writeUsersToCSV(users) {
  // normalize before writing
  const normalizedUsers = users.map((u) => {
    const normalized = {};
    CSV_FIELDS.forEach((field) => {
      normalized[field] = u[field] || '';
    });
    return normalized;
  });

  lockfile
    .lock(csvFilePath, { retries: 3 })
    .then((release) => {
      const csvData = parse(normalizedUsers, { fields: CSV_FIELDS });
      fs.writeFileSync(csvFilePath, csvData + '\n');
      release();
    })
    .catch((err) => console.error('Error writing users CSV:', err));
}

function writeUsersToCSV(users) {
  // ensure consistent column order matching header
  const fields = [
    'id',
    'username',
    'first_name',
    'last_name',
    'email',
    'status',
    'payment_reference',
    'subscription_start',
  ];
  lockfile
    .lock(csvFilePath, { retries: 3 })
    .then((release) => {
      const csvData = parse(users, { fields });
      fs.writeFileSync(csvFilePath, csvData + '\n');
      release();
    })
    .catch((err) => console.error('Error writing users CSV:', err));
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
      bot
        .sendMessage(user.id, `⏳ Your VIP subscription expires in 5 days.`)
        .catch(console.error);
    } else if (daysDiff === 29) {
      bot
        .sendMessage(user.id, `⚠️ Your VIP subscription expires tomorrow.`)
        .catch(console.error);
    } else if (daysDiff >= 30) {
      try {
        await bot.banChatMember(VIP_GROUP_CHAT_ID, user.id);
        await bot.unbanChatMember(VIP_GROUP_CHAT_ID, user.id);
        bot
          .sendMessage(
            user.id,
            `🚫 Subscription expired. You have been removed.`
          )
          .catch(console.error);
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
  const users = await readUsersFromCSV();
  const user = users.find((u) => u.id === String(msg.chat.id));
  if (!user || user.status !== 'true')
    return bot.sendMessage(msg.chat.id, '❌ Not an active VIP member.');
  const expiry = new Date(user.subscription_start);
  expiry.setDate(expiry.getDate() + 30);
  const daysLeft = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
  bot
    .sendMessage(
      msg.chat.id,
      `✅ VIP active\nExpires in: ${daysLeft} day(s)\nDate: ${expiry.toDateString()}`
    )
    .catch(console.error);
});

bot.onText(/\/renew/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await readUsersFromCSV();
  const user = users.find((u) => u.id === String(chatId));
  if (!user) return bot.sendMessage(chatId, '❌ Not registered. Use /start.');
  bot
    .sendMessage(chatId, 'Select payment method to renew:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇳🇬 Naira (Paystack)', callback_data: 'renew_nigeria' }],
          [{ text: '💱 USDT (Crypto)', callback_data: 'crypto' }],
        ],
      },
    })
    .catch(console.error);
});

bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  await bot.answerCallbackQuery(callbackQuery.id).catch(console.error);

  console.log('Callback query received:', data);

  const users = await readUsersFromCSV();
  const userIndex = users.findIndex((u) => u.id === String(message.chat.id));
  if (userIndex === -1)
    return bot.sendMessage(
      message.chat.id,
      '❌ User not found. Please register first.'
    );

  const user = users[userIndex];

  if (data === 'ghana') {
    const amount = GHANA_PRICE;
    const currency = CURRENCY_MAP.ghana;
    const paymentReference = generatePaymentReference();
    user.payment_reference = paymentReference;
    users[userIndex] = user;
    writeUsersToCSV(users);

    try {
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount,
          currency,
          reference: paymentReference,
          metadata: {
            telegram_id: message.chat.id, // 👈 ensure webhook knows user
            first_name: message.from.first_name,
            username: message.from.username,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const paymentUrl = response.data.data.authorization_url;
      bot
        .sendMessage(
          message.chat.id,
          `💳 The price is ${amount / 100} ${currency}. Click below to pay:`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]],
            },
          }
        )
        .catch(console.error);
    } catch (error) {
      console.error(
        'Payment initialization error (Ghana):',
        error.response?.data || error.message
      );
      bot
        .sendMessage(
          message.chat.id,
          '❌ Payment initialization failed. Please try again later.'
        )
        .catch(console.error);
    }
  } else if (data === 'nigeria' || data === 'renew_nigeria') {
    const amount = NIGERIA_PRICE;
    const currency = CURRENCY_MAP.nigeria;
    const paymentReference = generatePaymentReference();
    user.payment_reference = paymentReference;
    users[userIndex] = user;
    writeUsersToCSV(users);

    try {
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount,
          currency,
          reference: paymentReference,
          metadata: {
            telegram_id: message.chat.id, // 👈 store Telegram user ID here
            first_name: message.from.first_name, // optional extra
            username: message.from.username, // optional extra
          },
        },
        {
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const paymentUrl = response.data.data.authorization_url;
      await bot.sendMessage(
        message.chat.id,
        `💳 The price is ₦${amount / 100}. Click below to pay:`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]],
          },
        }
      );
    } catch (error) {
      console.error(
        'Payment initialization error (Nigeria):',
        error.response?.data || error.message
      );
      await bot.sendMessage(
        message.chat.id,
        '❌ Payment initialization failed. Please try again later.'
      );
    }
  }
});

function hexToTronBase58(hexAddress) {
  const base58 = require('bs58check');
  const addressBytes = Buffer.from(hexAddress.slice(2), 'hex');
  const prefix = Buffer.from([0x41]);
  const fullAddress = Buffer.concat([prefix, addressBytes]);
  return base58.encode(fullAddress);
}

bot.onText(/\/verify (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const reference = match[1].trim();

  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${paystackSecretKey}` },
      }
    );

    const data = response.data.data;

    if (data.status === 'success') {
      await bot.sendMessage(
        chatId,
        `✅ Payment verified!\n\nAmount: ${data.currency} ${
          data.amount / 100
        }\nEmail: ${data.customer.email}\nRef: ${data.reference}`
      );

      const users = await readUsersFromCSV();
      const userIndex = users.findIndex(
        (u) =>
          u.payment_reference === reference ||
          (u.email || '').toLowerCase() ===
            (data.customer.email || '').toLowerCase()
      );
      if (userIndex !== -1) {
        const user = users[userIndex];
        user.status = 'true';
        user.subscription_start = new Date().toISOString();
        user.payment_reference = reference;
        users[userIndex] = user;
        writeUsersToCSV(users);

        await bot.sendMessage(
          chatId,
          '🎉 You are now activated! Here’s your VIP join link:'
        );
        await bot.sendMessage(chatId, VIP_GROUP_URL);
      }
    } else {
      bot.sendMessage(
        chatId,
        `❌ Payment not successful.\nStatus: ${data.status}`
      );
    }
  } catch (error) {
    console.error('Verification error:', error.response?.data || error.message);
    bot.sendMessage(
      chatId,
      '⚠️ Could not verify payment. Please try again later.'
    );
  }
});

bot.onText(/\/crypto/, (msg) => {
  const chatId = msg.chat.id;
  const paymentAmount = 5;
  const yourTRC20Wallet = 'TMuVT2cUkxRUxatHhUYKcBV7c5vDarm1PE';
  bot
    .sendMessage(
      chatId,
      `🔐 *Crypto Payment - USDT (TRC-20)*\n\nPlease send *${paymentAmount} USDT* to:\n\`${yourTRC20Wallet}\`\n\nReply with the *TXID* to verify.`,
      { parse_mode: 'Markdown' }
    )
    .catch(console.error);
});

bot.onText(/^[a-fA-F0-9]{64}$/, async (msg) => {
  const chatId = msg.chat.id;
  const txid = msg.text.trim();

  const users = await readUsersFromCSV();
  const userIndex = users.findIndex((u) => u.id === String(chatId));
  if (userIndex === -1) return;

  const user = users[userIndex];

  if (user.payment_reference && user.payment_reference.includes(txid)) {
    return bot
      .sendMessage(chatId, '❗ This TXID has already been used.')
      .catch(console.error);
  }

  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/transactions/${txid}`,
      { headers: { 'TRON-PRO-API-KEY': tronGridApiKey } }
    );

    const tx = res.data.data[0];
    if (!tx || tx.ret[0].contractRet !== 'SUCCESS') {
      return bot
        .sendMessage(chatId, '❌ Invalid or failed transaction.')
        .catch(console.error);
    }

    const contract = tx.raw_data.contract[0];
    const method = contract.parameter.value.data.slice(0, 8);
    const recipientHex = '0x' + contract.parameter.value.data.slice(32, 72);
    const amountHex = contract.parameter.value.data.slice(72);

    const recipientAddressBase58 = hexToTronBase58(recipientHex);
    const amount = parseInt(amountHex, 16) / 1e6;

    const expectedWallet = 'TMuVT2cUkxRUxatHhUYKcBV7c5vDarm1PE';
    if (
      method.toLowerCase() === 'a9059cbb' &&
      recipientAddressBase58 === expectedWallet &&
      amount >= 5
    ) {
      user.status = 'true';
      user.subscription_start = new Date().toISOString();
      user.payment_reference = `USDT-${txid}`;
      users[userIndex] = user;
      writeUsersToCSV(users);

      await bot.sendMessage(chatId, `✅ Payment confirmed! Welcome to VIP.`);
      return bot
        .sendMessage(chatId, `Click below to join:`, {
          reply_markup: {
            inline_keyboard: [[{ text: 'Join VIP Group', url: VIP_GROUP_URL }]],
          },
        })
        .catch(console.error);
    } else {
      return bot
        .sendMessage(chatId, '⚠️ Payment validation failed.')
        .catch(console.error);
    }
  } catch (err) {
    console.error('TRON verification error:', err);
    return bot
      .sendMessage(chatId, '❌ Error verifying transaction.')
      .catch(console.error);
  }
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot
    .sendPhoto(chatId, 'TC.png', {
      caption: 'Please read the terms and conditions.',
    })
    .then(() => bot.sendMessage(chatId, 'Please provide your email address:'))
    .catch(console.error);

  const collector = (reply) => {
    if (
      reply.chat &&
      reply.chat.id === chatId &&
      reply.text &&
      !reply.text.startsWith('/')
    ) {
      const email = reply.text.trim();
      const user = {
        id: reply.from.id,
        username: reply.from.username || '',
        first_name: reply.from.first_name || '',
        last_name: reply.from.last_name || '',
        email,
        status: 'false',
        payment_reference: '',
        subscription_start: '',
      };

      readUsersFromCSV()
        .then((users) => {
          const exists = users.some((u) => u.id === String(user.id));
          if (!exists) {
            users.push(user);
            writeUsersToCSV(users);
            bot
              .sendMessage(
                chatId,
                'You have been registered. Click /subscribe.'
              )
              .catch(console.error);
          } else {
            bot
              .sendMessage(chatId, 'Welcome back. Click /subscribe.')
              .catch(console.error);
          }
        })
        .catch((err) => console.error('Error reading users on /start:', err));

      // remove listener after use
      bot.removeListener('message', collector);
    }
  };

  bot.on('message', collector);
});

bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  bot
    .sendMessage(chatId, 'Where are you paying from?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Nigeria', callback_data: 'nigeria' }],
          [{ text: 'Ghana', callback_data: 'ghana' }],
        ],
      },
    })
    .catch(console.error);
});

function generatePaymentReference() {
  return `PAY-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
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
