process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const csv = require('csv-parser');
const { parse } = require('json2csv');
const axios = require('axios');
const schedule = require('node-schedule');
require('dotenv').config(); // Load environment variables from .env file

// Replace with your bot token
// Replace with your bot token
const token = process.env.TELEGRAM_BOT_TOKEN;
const url = process.env.RENDER_APP_URL; // Use Render app URL
const port = process.env.PORT || 3001;

const bot = new TelegramBot(token, { webHook: true });
bot.setWebHook(`${url}/bot${token}`);

const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.json());

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Express server is listening on ${port}`);
});

// Paystack secret key
const paystackSecretKey =
  process.env.PAYSTACK_SECRET_KEY || 'YOUR_PAYSTACK_SECRET_KEY';

// CSV file path
const csvFilePath = 'users.csv';

// Ensure the CSV file exists
if (!fs.existsSync(csvFilePath)) {
  fs.writeFileSync(
    csvFilePath,
    'id,username,first_name,last_name,email,status,payment_reference,subscription_start\n'
  );
}

// Listen for '/start' command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  // Send the terms and conditions picture
  bot
    .sendPhoto(chatId, 'TC.jpg', {
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
        subscription_start: '', // Initialize as an empty string
      };

      // Check if user is already in the CSV
      let userExists = false;
      const users = [];

      fs.createReadStream(csvFilePath)
        .pipe(csv())
        .on('data', (row) => {
          users.push(row);
          if (row.id === String(user.id)) {
            userExists = true;
          }
        })
        .on('end', () => {
          if (!userExists) {
            const csvString = parse([user], { header: false });
            fs.appendFileSync(csvFilePath, csvString + '\n');
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
        });
    } else {
      bot.sendMessage(
        chatId,
        'Invalid email address. Please Click /start to try again.'
      );
    }
  });
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
          // Add more countries if needed
        ],
      },
    }
  );
});

// Function to get user email from CSV by chat ID
function getUserEmail(chatId) {
  return new Promise((resolve, reject) => {
    const users = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.id === String(chatId)) {
          resolve(row.email);
        }
        users.push(row);
      })
      .on('end', () => {
        resolve(null); // Return null if email not found
      });
  });
}

// Function to verify payment using Paystack API
async function verifyPayment(reference) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
        },
      }
    );

    return response.data.status && response.data.data.status === 'success';
  } catch (error) {
    console.error(
      'Error verifying payment:',
      error.response ? error.response.data : error.message
    );
    return false;
  }
}

// Handle button clicks
bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;

  if (data === 'made_payment') {
    await bot.sendMessage(
      message.chat.id,
      'Please enter your payment reference on the receipt sent to your email:'
    );

    bot.once('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        const paymentReference = msg.text;
        const isPaymentValid = await verifyPayment(paymentReference);

        if (isPaymentValid) {
          // Update payment reference in CSV and notify user
          const users = [];
          fs.createReadStream(csvFilePath)
            .pipe(csv())
            .on('data', (row) => {
              if (row.id === String(msg.from.id)) {
                row.payment_reference = paymentReference;
                row.status = 'true'; // Update status to 'true' if payment is valid
                row.subscription_start = new Date().toISOString(); // Store the subscription start date
              }
              users.push(row);
            })
            .on('end', () => {
              const csvString = parse(users, { header: true });
              fs.writeFileSync(csvFilePath, csvString);
              bot.sendMessage(
                msg.chat.id,
                'Payment verified successfully. You now have access to the VIP. Click the button below to join now.',
                {
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: 'Join VIP Group',
                          url: 'https://t.me/+z0-HqT_ofAcwZTBk', // VIP group invite link
                        },
                      ],
                    ],
                  },
                }
              );
            });
        } else {
          bot.sendMessage(
            msg.chat.id,
            'Invalid payment reference. Please Click /start to register again.'
          );
        }
      }
    });
  } else {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(message.chat.id, `You selected: ${data}`);

    // Read user email from CSV
    const userEmail = await getUserEmail(message.chat.id);
    if (userEmail) {
      console.log('Retrieved email:', userEmail); // Debugging log

      let amount, currency;
      if (data === 'ghana') {
        amount = 488 * 100; // Amount in pesewas (e.g., 488 cedis)
        currency = 'GHS'; // Currency for Ghana
      } else if (data === 'nigeria') {
        amount = 50000 * 100; // Amount in kobo (e.g., 50000 kobo = N50,000)
        currency = 'NGN'; // Currency for Nigeria
      } else {
        // Handle other countries if needed
        amount = 50000 * 100; // Default to Naira
        currency = 'NGN';
      }

      try {
        const response = await axios.post(
          'https://api.paystack.co/transaction/initialize',
          {
            email: userEmail, // User's email address
            amount: amount, // Amount based on selected country
            currency: currency, // Currency based on selected country
          },
          {
            headers: {
              Authorization: `Bearer ${paystackSecretKey}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const paymentUrl = response.data.data.authorization_url;

        // Send the payment URL to the user with a button
        await bot.sendMessage(
          message.chat.id,
          `The price for VIP subscription is ${amount / 100} ${
            currency === 'NGN' ? 'Naira' : 'Cedis'
          } for 30 days. Please make the payment using the button below:`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: 'Pay Now',
                    url: paymentUrl, // Embed the payment URL in the button
                  },
                ],
              ],
            },
          }
        );

        await bot.sendMessage(
          message.chat.id,
          'After making the payment, click "I have made payment" and provide the payment reference.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: 'I have made payment',
                    callback_data: 'made_payment',
                  },
                ],
              ],
            },
          }
        );
      } catch (error) {
        console.error(
          'Error creating Paystack payment link:',
          error.response ? error.response.data : error.message
        );
        await bot.sendMessage(
          message.chat.id,
          `An error occurred while creating the payment link: ${
            error.response ? error.response.data.message : error.message
          }. Please try again later.`
        );
      }
    } else {
      await bot.sendMessage(
        message.chat.id,
        'Email not found. Please click /start to register.'
      );
    }
  }
});

// Listen for '/payment' command (for testing)
bot.onText(/\/payment/, async (msg) => {
  const chatId = msg.chat.id;
  const email = 'example@example.com'; // Replace with user's email
  const amount = 50000 * 100; // Amount in kobo (e.g., 50000 kobo = N50,000)
  const currency = 'NGN'; // Currency (NGN for Naira)

  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: email,
        amount: amount,
        currency: currency,
      },
      {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const paymentUrl = response.data.data.authorization_url;

    // Send the payment URL to the user with a button
    await bot.sendMessage(
      chatId,
      'Click the button below to make the payment:',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Pay Now',
                url: paymentUrl, // Embed the payment URL in the button
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error(
      'Error creating Paystack payment link:',
      error.response ? error.response.data : error.message
    );
    await bot.sendMessage(
      chatId,
      `An error occurred while creating the payment link: ${
        error.response ? error.response.data.message : error.message
      }. Please try again later.`
    );
  }
});

// Function to check subscription status and send daily predictions
async function checkSubscriptionAndSendPredictions() {
  const today = new Date();
  const users = [];

  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => {
      const subscriptionStart = new Date(row.subscription_start);
      const subscriptionEnd = new Date(
        subscriptionStart.setDate(subscriptionStart.getDate() + 30)
      );

      // Check if subscription is still valid
      if (row.status === 'true' && subscriptionEnd >= today) {
        users.push(row);
      }
    })
    .on('end', () => {
      // Send daily predictions to subscribed users
      users.forEach((user) => {
        bot.sendMessage(
          user.id,
          'Here is your daily prediction: ...' // Replace with actual prediction
        );
      });
    });
}

// Schedule job to run every day at 6 AM
schedule.scheduleJob('0 6 * * *', checkSubscriptionAndSendPredictions);

// Listen for any other message
// bot.on('message', (msg) => {
//   const chatId = msg.chat.id;
//   bot.sendMessage(chatId, 'Please use /start to register.');
// });

console.log('Bot is running...');
