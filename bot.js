const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const axios = require('axios');
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

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const VIP_GROUP_URL = 'https://t.me/+2AsqyFrMUgUwYjM0';
const GHANA_PRICE = 5000 * 100; // GHS 5,000 (Paystack expects minor unit)
const NIGERIA_PRICE = 7000 * 100; // ₦75,000 -> 75,000 * 100 (naira)
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

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post('/paystack/webhook', (req, res) => {
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

      getUsersFromDB()
        .then(async (users) => {
          const user = users.find(
            (u) =>
              u.payment_reference === reference ||
              (telegramId && u.id == telegramId) ||
              (email && (u.email || '').toLowerCase() === email)
          );

          if (user) {
            const updatedUser = {
              ...user,
              status: true,
              subscription_start: new Date().toISOString(),
              payment_reference: reference || user.payment_reference,
              updated_at: new Date().toISOString(),
            };

            if (telegramId) updatedUser.id = telegramId;
            if (firstName) updatedUser.first_name = firstName;
            if (username) updatedUser.username = username;
            if (email) updatedUser.email = email;

            await updateUserInDB(updatedUser);

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
            const newUser = {
              id: telegramId || `paystack_${Date.now()}`,
              username,
              first_name: firstName,
              last_name: '',
              email,
              status: true,
              payment_reference: reference,
              subscription_start: new Date().toISOString(),
            };

            await createUserInDB(newUser);

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
          console.error('Error reading users from DB on webhook:', err)
        );
    }
  } catch (err) {
    console.error('❌ Exception handling Paystack webhook:', err);
  }
});

async function getUsersFromDB() {
  try {
    const { data, error } = await supabase.from('users').select('*');

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching users from DB:', error);
    return [];
  }
}

async function createUserInDB(user) {
  try {
    const { data, error } = await supabase
      .from('users')
      .insert([user])
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error('Error creating user in DB:', error);
    throw error;
  }
}

async function updateUserInDB(user) {
  try {
    const { data, error } = await supabase
      .from('users')
      .update(user)
      .eq('id', user.id)
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error('Error updating user in DB:', error);
    throw error;
  }
}

async function getUserFromDB(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 is "not found"
    return data;
  } catch (error) {
    console.error('Error fetching user from DB:', error);
    return null;
  }
}

async function manageSubscriptionExpirations() {
  const currentDate = new Date();
  const users = await getUsersFromDB();

  for (const user of users) {
    if (!user.subscription_start || user.status !== true) continue;

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

        await updateUserInDB({
          ...user,
          status: false,
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`Error removing user ${user.id}:`, err.message);
      }
    }
  }
}

bot.onText(/\/status/, async (msg) => {
  const user = await getUserFromDB(String(msg.chat.id));
  if (!user || user.status !== true)
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
  const user = await getUserFromDB(String(chatId));
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

  const user = await getUserFromDB(String(message.chat.id));
  if (!user)
    return bot.sendMessage(
      message.chat.id,
      '❌ User not found. Please register first.'
    );

  if (data === 'ghana') {
    const amount = GHANA_PRICE;
    const currency = CURRENCY_MAP.ghana;
    const paymentReference = generatePaymentReference();

    await updateUserInDB({
      ...user,
      payment_reference: paymentReference,
      updated_at: new Date().toISOString(),
    });

    try {
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount,
          currency,
          reference: paymentReference,
          metadata: {
            telegram_id: message.chat.id,
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

    await updateUserInDB({
      ...user,
      payment_reference: paymentReference,
      updated_at: new Date().toISOString(),
    });

    try {
      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: user.email,
          amount,
          currency,
          reference: paymentReference,
          metadata: {
            telegram_id: message.chat.id,
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
          `💳 The price is ₦${amount / 100}. Click below to pay:`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]],
            },
          }
        )
        .catch(console.error);
    } catch (error) {
      console.error(
        'Payment initialization error (Nigeria):',
        error.response?.data || error.message
      );
      bot
        .sendMessage(
          message.chat.id,
          '❌ Payment initialization failed. Please try again later.'
        )
        .catch(console.error);
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
      bot.sendMessage(
        chatId,
        `✅ Payment verified!\n\nAmount: ${data.currency} ${
          data.amount / 100
        }\nEmail: ${data.customer.email}\nRef: ${data.reference}`
      );

      const users = await getUsersFromDB();
      const user = users.find(
        (u) =>
          u.payment_reference === reference ||
          (u.email || '').toLowerCase() ===
            (data.customer.email || '').toLowerCase()
      );

      if (user) {
        const updatedUser = {
          ...user,
          status: true,
          subscription_start: new Date().toISOString(),
          payment_reference: reference,
          updated_at: new Date().toISOString(),
        };

        await updateUserInDB(updatedUser);

        bot
          .sendMessage(
            chatId,
            "🎉 You are now activated! Here's your VIP join link:"
          )
          .catch(console.error);
        bot.sendMessage(chatId, VIP_GROUP_URL).catch(console.error);
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

  const user = await getUserFromDB(String(chatId));
  if (!user) return;

  if (user.payment_reference && user.payment_reference.includes(txid)) {
    return bot
      .sendMessage(chatId, '❗ This TXID has already been used.')
      .catch(console.error);
  }

  try {
    const res = await axios.get(
      `https://api.trongrid.io/v1/transactions/${txid}`,
      {
        headers: { 'TRON-PRO-API-KEY': tronGridApiKey },
      }
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
    const amount = Number.parseInt(amountHex, 16) / 1e6;

    const expectedWallet = 'TMuVT2cUkxRUxatHhUYKcBV7c5vDarm1PE';
    if (
      method.toLowerCase() === 'a9059cbb' &&
      recipientAddressBase58 === expectedWallet &&
      amount >= 5
    ) {
      const updatedUser = {
        ...user,
        status: true,
        subscription_start: new Date().toISOString(),
        payment_reference: `USDT-${txid}`,
        updated_at: new Date().toISOString(),
      };

      await updateUserInDB(updatedUser);

      bot
        .sendMessage(chatId, `✅ Payment confirmed! Welcome to VIP.`)
        .catch(console.error);
      bot
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

  const collector = async (reply) => {
    if (
      reply.chat &&
      reply.chat.id === chatId &&
      reply.text &&
      !reply.text.startsWith('/')
    ) {
      const email = reply.text.trim();
      const newUser = {
        id: String(reply.from.id),
        username: reply.from.username || '',
        first_name: reply.from.first_name || '',
        last_name: reply.from.last_name || '',
        email,
        status: false,
        payment_reference: '',
        subscription_start: null,
      };

      try {
        const existingUser = await getUserFromDB(newUser.id);

        if (!existingUser) {
          await createUserInDB(newUser);
          bot
            .sendMessage(chatId, 'You have been registered. Click /subscribe.')
            .catch(console.error);
        } else {
          bot
            .sendMessage(chatId, 'Welcome back. Click /subscribe.')
            .catch(console.error);
        }
      } catch (err) {
        console.error('Error handling user registration:', err);
        bot
          .sendMessage(chatId, '❌ Registration failed. Please try again.')
          .catch(console.error);
      }

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
