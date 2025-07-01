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
const csvFilePath = 'users.csv';

const VIP_GROUP_URL = 'https://t.me/+bmG1AjEf0AYxN2M0';
const GHANA_PRICE = 488 * 100; // In pesewas
const NIGERIA_PRICE = 5 * 100; // In kobo
const CURRENCY_MAP = {
  nigeria: 'NGN',
  ghana: 'GHS',
};

const bot = new TelegramBot(token, { webHook: true });
bot.setWebHook(`${url}/bot${token}`);

const app = express();
app.use(bodyParser.json());

// Endpoint for webhook to trigger CSV sync
app.post('/sync-csv', (req, res) => {
  syncCSVWithRender();
  res.status(200).send('CSV sync triggered.');
});

if (!fs.existsSync(csvFilePath)) {
  fs.writeFileSync(
    csvFilePath,
    'id,username,first_name,last_name,email,status,payment_reference,subscription_start\n'
  );
}

// Serve the CSV file at /users.csv endpoint
app.get('/users.csv', (req, res) => {
  const filePath = path.join(__dirname, csvFilePath);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Error sending file:', err);
      res.status(404).send('File not found');
    }
  });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Function to periodically sync the CSV file with Render
async function syncCSVWithRender() {
  try {
    const response = await axios.get(`${url}/users.csv`);
    fs.writeFileSync(csvFilePath, response.data);
    console.log('CSV file synchronized with Render.');
  } catch (error) {
    console.error('Error synchronizing CSV with Render:', error.message);
  }
}

// Schedule the CSV sync to happen every 5 minutes
setInterval(syncCSVWithRender, 5 * 60 * 1000);

function readUsersFromCSV() {
  return new Promise((resolve, reject) => {
    const users = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => users.push(row))
      .on('end', () => resolve(users))
      .on('error', (error) => reject(error));
  });
}

function writeUsersToCSV(users) {
  lockfile
    .lock(csvFilePath, { retries: 3 })
    .then((release) => {
      const csvString = parse(users, { header: true });
      fs.writeFileSync(csvFilePath, csvString);
      release();
    })
    .catch((error) => {
      console.error('Error locking CSV file:', error);
    });
}

// Subscription expiration management
function manageSubscriptionExpirations() {
  const currentDate = new Date();
  readUsersFromCSV()
    .then((users) => {
      const updatedUsers = users.map((user) => {
        if (user.subscription_start) {
          const subscriptionStart = new Date(user.subscription_start);
          const daysDiff = Math.floor(
            (currentDate - subscriptionStart) / (1000 * 60 * 60 * 24)
          );

          if (daysDiff === 25) {
            bot.sendMessage(
              user.id,
              `Your VIP subscription will expire in 5 days. Please renew it before it expires.`
            );
          } else if (daysDiff >= 30) {
            user.status = 'false'; // Mark user as inactive
            bot.sendMessage(
              user.id,
              `Your VIP subscription has expired. Please renew to continue enjoying the benefits.`
            );
          }
        }
        return user;
      });

      // Write the updated users back to the CSV
      writeUsersToCSV(updatedUsers);
    })
    .catch((error) => {
      console.error('Error reading users from CSV:', error.message);
    });
}

//add paystack webhook route

app.post('/paystack/webhook', (req, res) => {
  const hash = crypto
    .createHmac('sha512', paystackSecretKey)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash === req.headers['x-paystack-signature']) {
    const event = req.body.event;

    if (event === 'charge.success') {
      const data = req.body.data;
      const email = data.customer.email;
      const reference = data.reference;

      readUsersFromCSV()
        .then((users) => {
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
        })
        .catch((err) => console.error('Error verifying payment:', err));
    }
  }

  res.sendStatus(200);
});

// Schedule the expiration check job to run daily at midnight
schedule.scheduleJob('0 0 * * *', manageSubscriptionExpirations);

// Register new users
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  bot
    .sendPhoto(chatId, 'TC.png', {
      caption: 'Please read the terms and conditions before proceeding.',
    })
    .then(() => {
      bot.sendMessage(chatId, 'Please provide your email address:');
    });

  bot.once('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
      const email = msg.text;
      const user = {
        id: msg.from.id,
        username: msg.from.username || '',
        first_name: msg.from.first_name || '',
        last_name: msg.from.last_name || '',
        email: email,
        status: 'false',
        payment_reference: '',
        subscription_start: '',
      };

      readUsersFromCSV()
        .then((users) => {
          const userExists = users.some((u) => u.id === String(user.id));

          if (!userExists) {
            users.push(user);
            writeUsersToCSV(users);
            bot.sendMessage(
              chatId,
              'You have been registered successfully. Click /subscribe to continue.'
            );
          } else {
            bot.sendMessage(
              chatId,
              'Welcome back. Click /subscribe to continue.'
            );
          }
        })
        .catch((error) => {
          console.error('Error reading from CSV:', error);
          bot.sendMessage(
            chatId,
            'An error occurred during registration. Please try again.'
          );
        });
    } else {
      bot.sendMessage(
        chatId,
        'Invalid email address. Please click /start to try again.'
      );
    }
  });
});

// Handle subscription
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
        ],
      },
    }
  );
});

// Payment handling logic
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;

  await bot.answerCallbackQuery(callbackQuery.id); // Acknowledge the callback query
  await bot.sendMessage(message.chat.id, `You selected: ${data}`);

  readUsersFromCSV()
    .then((users) => {
      const user = users.find((u) => u.id === String(message.chat.id));
      if (user) {
        let amount, currency;
        if (data === 'ghana') {
          amount = GHANA_PRICE;
          currency = CURRENCY_MAP.ghana;
        } else if (data === 'nigeria') {
          amount = NIGERIA_PRICE;
          currency = CURRENCY_MAP.nigeria;
        }

        axios
          .post(
            'https://api.paystack.co/transaction/initialize',
            { email: user.email, amount, currency },
            {
              headers: {
                Authorization: `Bearer ${paystackSecretKey}`,
                'Content-Type': 'application/json',
              },
            }
          )
          .then((response) => {
            const paymentUrl = response.data.data.authorization_url;
            bot.sendMessage(
              message.chat.id,
              `The price for VIP subscription is ${amount / 100} ${
                currency === 'NGN' ? 'Naira' : 'Cedis'
              } for 30 days. Please make the payment using the button below:`,
              {
                reply_markup: {
                  inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]],
                },
              }
            );
            handlePaymentReference(message.chat.id, user);
          })
          .catch((error) => {
            console.error('Payment initialization error:', error.message);
            bot.sendMessage(
              message.chat.id,
              'An error occurred while initializing payment. Please try again later.'
            );
          });
      }
    })
    .catch((error) => {
      console.error('Error reading users from CSV:', error.message);
    });
});

async function handlePaymentReference(userId, user) {
  try {
    const paymentReference = generatePaymentReference();
    user.payment_reference = paymentReference;
    user.subscription_start = new Date().toISOString(); // Set the subscription start date
    user.status = 'true'; // Mark the user as active

    // Update the user in the CSV file
    const users = await readUsersFromCSV();
    const updatedUsers = users.map((u) => (u.id === String(userId) ? user : u));
    writeUsersToCSV(updatedUsers);

    bot.sendMessage(
      userId,
      `Your subscription has been activated successfully. Enjoy our VIP services!`
    );
  } catch (error) {
    console.error('Error handling payment reference:', error.message);
    bot.sendMessage(
      userId,
      'An error occurred while activating your subscription. Please try again.'
    );
  }
}

// Helper function to generate a unique payment reference
function generatePaymentReference() {
  return `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}
