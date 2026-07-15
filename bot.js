const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const axios = require('axios');
const schedule = require('node-schedule');
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.RENDER_APP_URL; // e.g. https://your-app.onrender.com
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const tronGridApiKey = process.env.TRONGRID_API_KEY;
const VIP_GROUP_CHAT_ID = process.env.VIP_GROUP_CHAT_ID; // numeric chat id for programmatic actions

const firebaseServiceAccount =
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const firebaseCollection =
  process.env.FIREBASE_COLLECTION || 'certipredusers';

const VIP_GROUP_URL = 'https://t.me/+2AsqyFrMUgUwYjM0';
const GHANA_PRICE = 5000 * 100; // GHS 5,000 (Paystack expects minor unit)
const NIGERIA_PRICE =100 * 100; // ₦75,000 -> 75,000 * 100 (naira)
const CURRENCY_MAP = { nigeria: 'NGN', ghana: 'GHS' };
const SUBSCRIPTION_DAYS = 1;
const REMINDER_DAYS_BEFORE_EXPIRY = 3;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!firebaseServiceAccount)
  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_BASE64 in .env'
  );
if (!url)
  console.warn(
    'RENDER_APP_URL missing in .env — webhook may not set correctly'
  );

function parseFirebaseServiceAccount(value) {
  const trimmed = value.trim();
  const json = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');

  try {
    const serviceAccount = JSON.parse(json);

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(
        /\\n/g,
        '\n'
      );
    }

    return serviceAccount;
  } catch (error) {
    throw new Error(
      'Invalid Firebase service account. Set FIREBASE_SERVICE_ACCOUNT to the raw JSON, or FIREBASE_SERVICE_ACCOUNT_BASE64 to a base64-encoded Firebase service account JSON file.'
    );
  }
}

const firebaseApp = admin.initializeApp({
  credential: admin.cert(
    parseFirebaseServiceAccount(firebaseServiceAccount)
  ),
});

const db = getFirestore(firebaseApp);
const usersCollection = db.collection(firebaseCollection);

const bot = new TelegramBot(token, { webHook: true });
if (url) {
  bot.setWebHook(`${url}/webhook`);
}

const app = express();

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post('/paystack/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      console.warn('⚠️ No x-paystack-signature header present');
      return res.sendStatus(400);
    }

    const hash = crypto
      .createHmac('sha512', paystackSecretKey)
      .update(req.rawBody)
      .digest('hex');

    if (hash !== signature) {
      console.warn('❌ Paystack signature mismatch.', {
        reference: req.body?.data?.reference,
      });
      return res.sendStatus(401);
    }

    const { event, data } = req.body;
    console.log('⚡ Paystack event:', event, 'ref:', data?.reference);

    if (event === 'charge.success') {
      const email = (data.customer?.email || '').toLowerCase();
      const reference = data.reference;
      const telegramId = data.metadata?.telegram_id
        ? String(data.metadata.telegram_id)
        : '';
      const firstName = data.metadata?.first_name || '';
      const username = data.metadata?.username || '';

      const user = await findUserForPayment(reference, telegramId, email);
      const userPayload = {
        ...(user || {}),
        telegram_id: telegramId || getTelegramId(user),
        username,
        first_name: firstName,
        last_name: user?.last_name || '',
        email,
      };

      if (!getTelegramId(userPayload)) {
        console.error('❌ Paystack webhook could not resolve Telegram user', {
          reference,
          email,
          metadata: data.metadata,
        });
        return res.sendStatus(422);
      }

      const activatedUser = user
        ? await activateSubscription(userPayload, reference)
        : await createActivatedUser(userPayload, reference);

      const activatedTelegramId = getTelegramId(activatedUser);
      if (activatedTelegramId) {
        await sendVipInvite(
          activatedTelegramId,
          `✅ Payment confirmed!\n\nWelcome to CertiPred VIP 🎉`
        );
      }

      console.log(`🎉 Activated user ${getTelegramId(activatedUser)} for ref ${reference}`);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Exception handling Paystack webhook:', err);
    return res.sendStatus(500);
  }
});

function getTelegramId(user) {
  return user?.telegram_id ? String(user.telegram_id) : '';
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getSubscriptionExpiry(user) {
  if (user?.subscription_expires_at) {
    return new Date(user.subscription_expires_at);
  }

  if (!user?.subscription_start) return null;
  return addDays(new Date(user.subscription_start), SUBSCRIPTION_DAYS);
}

function buildSubscriptionFields(paymentReference) {
  const now = new Date();
  const expiresAt = addDays(now, SUBSCRIPTION_DAYS);

  return {
    status: true,
    payment_reference: paymentReference,
    payment_confirmed_at: now.toISOString(),
    subscription_start: now.toISOString(),
    subscription_expires_at: expiresAt.toISOString(),
    last_reminder_sent_at: '',
  };
}

function toFirebaseUserPayload(user) {
  return {
    telegram_id: getTelegramId(user),
    username: user.username || '',
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    email: user.email || '',
    status: user.status === true,
    payment_reference: user.payment_reference || '',
    payment_confirmed_at: user.payment_confirmed_at || '',
    subscription_start: user.subscription_start || '',
    subscription_expires_at: user.subscription_expires_at || '',
    joined_group_at: user.joined_group_at || '',
    left_group_at: user.left_group_at || '',
    is_in_vip_group: user.is_in_vip_group === true,
    last_reminder_sent_at: user.last_reminder_sent_at || '',
  };
}

async function getUsersFromDB() {
  try {
    const snapshot = await usersCollection.orderBy('created_at', 'desc').get();
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  } catch (error) {
    console.error('Error fetching users from Firebase:', error);
    return [];
  }
}

async function createUserInDB(user) {
  try {
    const telegramId = getTelegramId(user);
    if (!telegramId) throw new Error('Cannot create user without telegram_id');

    const payload = {
      ...toFirebaseUserPayload(user),
      created_at: user.created_at || new Date().toISOString(),
    };

    await usersCollection.doc(telegramId).set(payload, { merge: true });
    return {
      id: telegramId,
      ...payload,
    };
  } catch (error) {
    console.error('Error creating user in Firebase:', error);
    throw error;
  }
}

async function updateUserInDB(user) {
  try {
    const telegramId = getTelegramId(user) || user.id;
    if (!telegramId) throw new Error('Cannot update user without telegram_id');

    const payload = {
      ...toFirebaseUserPayload(user),
      updated_at: new Date().toISOString(),
    };

    await usersCollection.doc(String(telegramId)).set(payload, { merge: true });
    return {
      id: String(telegramId),
      ...payload,
    };
  } catch (error) {
    console.error('Error updating user in Firebase:', error);
    throw error;
  }
}

async function getUserFromDB(telegramId) {
  try {
    const doc = await usersCollection.doc(String(telegramId)).get();
    if (!doc.exists) return null;

    return {
      id: doc.id,
      ...doc.data(),
    };
  } catch (error) {
    console.error('Error fetching user from Firebase:', error);
    return null;
  }
}

async function findUserForPayment(reference, telegramId, email) {
  if (telegramId) {
    const user = await getUserFromDB(String(telegramId));
    if (user) return user;
  }

  const users = await getUsersFromDB();
  return (
    users.find(
      (user) =>
        user.payment_reference === reference ||
        (email && (user.email || '').toLowerCase() === email)
    ) || null
  );
}

async function createActivatedUser(user, paymentReference) {
  return createUserInDB({
    ...user,
    ...buildSubscriptionFields(paymentReference),
  });
}

async function activateSubscription(user, paymentReference) {
  return updateUserInDB({
    ...user,
    ...buildSubscriptionFields(paymentReference || user.payment_reference),
  });
}

async function sendVipInvite(chatId, message) {
  await bot.sendMessage(chatId, message).catch(console.error);
  return bot
    .sendMessage(chatId, '🚀 Click below to join the VIP group:', {
      reply_markup: {
        inline_keyboard: [[{ text: 'Join VIP Group', url: VIP_GROUP_URL }]],
      },
    })
    .catch(console.error);
}

async function manageSubscriptionExpirations() {
  const currentDate = new Date();
  const users = await getUsersFromDB();

  for (const user of users) {
    if (user.status !== true) continue;

    const telegramId = getTelegramId(user);
    const expiry = getSubscriptionExpiry(user);
    if (!telegramId || !expiry) continue;

    const daysLeft = Math.ceil((expiry - currentDate) / MS_PER_DAY);
    const reminderAlreadySent =
      user.last_reminder_sent_at &&
      new Date(user.last_reminder_sent_at) >= new Date(user.subscription_start);

    if (
      daysLeft > 0 &&
      daysLeft <= REMINDER_DAYS_BEFORE_EXPIRY &&
      !reminderAlreadySent
    ) {
      bot
        .sendMessage(
          telegramId,
          `⏳ Your VIP subscription expires in ${daysLeft} day(s). Please renew to keep access.`
        )
        .catch(console.error);

      await updateUserInDB({
        ...user,
        last_reminder_sent_at: currentDate.toISOString(),
      });
    } else if (currentDate >= expiry) {
      try {
        await bot.banChatMember(VIP_GROUP_CHAT_ID, telegramId);
        await bot.unbanChatMember(VIP_GROUP_CHAT_ID, telegramId);
        bot
          .sendMessage(
            telegramId,
            `🚫 Your VIP subscription has expired. You have been removed from the VIP group. Renew anytime to join again.`
          )
          .catch(console.error);

        await updateUserInDB({
          ...user,
          status: false,
          is_in_vip_group: false,
          left_group_at: currentDate.toISOString(),
        });
      } catch (err) {
        console.error(`Error removing user ${telegramId}:`, err.message);
      }
    }
  }
}

bot.onText(/\/status/, async (msg) => {
  const user = await getUserFromDB(String(msg.chat.id));
  if (!user || user.status !== true)
    return bot.sendMessage(msg.chat.id, '❌ Not an active VIP member.');

  const expiry = new Date(user.subscription_start);
  const subscriptionExpiry = getSubscriptionExpiry(user) || expiry;
  const daysLeft = Math.ceil((subscriptionExpiry - new Date()) / MS_PER_DAY);

  bot
    .sendMessage(
      msg.chat.id,
      `✅ VIP active\nExpires in: ${daysLeft} day(s)\nDate: ${subscriptionExpiry.toDateString()}`
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
  } else if (data === 'crypto') {
    sendCryptoInstructions(message.chat.id);
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

      const user =
        (await getUserFromDB(String(chatId))) ||
        (await findUserForPayment(
          reference,
          String(chatId),
          (data.customer.email || '').toLowerCase()
        ));

      if (user) {
        await activateSubscription(user, reference);

        bot
          .sendMessage(
            chatId,
            "🎉 You are now activated! Here's your VIP join link:"
          )
          .catch(console.error);
        bot
          .sendMessage(chatId, VIP_GROUP_URL)
          .catch(console.error);
      } else {
        bot
          .sendMessage(
            chatId,
            '⚠️ Payment was successful, but no registered user was found. Please use /start first.'
          )
          .catch(console.error);
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

function sendCryptoInstructions(chatId) {
  const paymentAmount = 5;
  const yourTRC20Wallet = 'TMuVT2cUkxRUxatHhUYKcBV7c5vDarm1PE';
  return bot
    .sendMessage(
      chatId,
      `🔐 *Crypto Payment - USDT (TRC-20)*\n\nPlease send *${paymentAmount} USDT* to:\n\`${yourTRC20Wallet}\`\n\nReply with the *TXID* to verify.`,
      { parse_mode: 'Markdown' }
    )
    .catch(console.error);
}

bot.onText(/\/crypto/, (msg) => {
  sendCryptoInstructions(msg.chat.id);
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
      await activateSubscription(user, `USDT-${txid}`);

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
        telegram_id: String(reply.from.id),
        username: reply.from.username || '',
        first_name: reply.from.first_name || '',
        last_name: reply.from.last_name || '',
        email,
        status: false,
        payment_reference: '',
        subscription_start: null,
        subscription_expires_at: null,
        payment_confirmed_at: null,
        joined_group_at: null,
        left_group_at: null,
        is_in_vip_group: false,
        last_reminder_sent_at: null,
      };

      try {
        const existingUser = await getUserFromDB(newUser.telegram_id);

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

bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(VIP_GROUP_CHAT_ID)) {
    if (msg.new_chat_members?.length || msg.left_chat_member) {
      console.warn('⚠️ Ignoring group membership event from unexpected chat', {
        chatId: msg.chat.id,
        expectedVipGroupChatId: VIP_GROUP_CHAT_ID,
      });
    }
    return;
  }

  if (msg.new_chat_members?.length) {
    for (const member of msg.new_chat_members) {
      const user = await getUserFromDB(String(member.id));
      const expiry = getSubscriptionExpiry(user);
      const hasActiveSubscription =
        user?.status === true && expiry && new Date() < expiry;

      if (!hasActiveSubscription) {
        console.warn('⚠️ Removing non-active user from VIP group', {
          telegramId: member.id,
          foundUser: Boolean(user),
        });
        await bot.banChatMember(VIP_GROUP_CHAT_ID, member.id).catch(console.error);
        await bot
          .unbanChatMember(VIP_GROUP_CHAT_ID, member.id)
          .catch(console.error);
        continue;
      }

      await updateUserInDB({
        ...user,
        joined_group_at: user.joined_group_at || new Date().toISOString(),
        left_group_at: '',
        is_in_vip_group: true,
      });

      console.log('✅ Logged VIP group join in Firebase', {
        telegramId: member.id,
      });
    }
  }

  if (msg.left_chat_member) {
    const user = await getUserFromDB(String(msg.left_chat_member.id));
    if (!user) {
      console.warn('⚠️ VIP group leave event for unknown user', {
        telegramId: msg.left_chat_member.id,
      });
      return;
    }

    await updateUserInDB({
      ...user,
      is_in_vip_group: false,
      left_group_at: new Date().toISOString(),
    });

    console.log('✅ Logged VIP group leave in Firebase', {
      telegramId: msg.left_chat_member.id,
    });
  }
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
