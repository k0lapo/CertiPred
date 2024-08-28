const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const csv = require('csv-parser');
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

const bot = new TelegramBot(token, { webHook: true });
bot.setWebHook(`${url}/bot${token}`);

const app = express();
app.use(bodyParser.json());

// Endpoint for webhook to trigger CSV sync
app.post('/sync-csv', (req, res) => {
  syncCSVWithRender();
  res.status(200).send('CSV sync triggered.');
});

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
const csvFilePath = 'users.csv';

if (!fs.existsSync(csvFilePath)) {
  fs.writeFileSync(
    csvFilePath,
    'id,username,first_name,last_name,email,status,payment_reference,subscription_start\n'
  );
}

// Serve the CSV file at /users.csv endpoint
app.get('/users.csv', (req, res) => {
  const filePath = path.join(__dirname, csvFilePath);  // Ensure the path is absolute
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Error sending file:', err);
      res.status(404).send('File not found');
    }
  });
});


const port = process.env.PORT || 0;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Function to periodically sync the CSV file with Render
function syncCSVWithRender() {
  axios
    .get(`${process.env.RENDER_APP_URL}/users.csv`)
    .then((response) => {
      fs.writeFileSync(csvFilePath, response.data);
      console.log('CSV file synchronized with Render.');
    })
    .catch((error) => {
      console.error('Error synchronizing CSV with Render:', error.message);
    });
}

// Schedule the CSV sync to happen every hour (adjust the interval as needed)
setInterval(syncCSVWithRender, 5 * 60 * 1000); // 5 minutes in milliseconds

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
  const csvString = parse(users, { header: true });
  fs.writeFileSync(csvFilePath, csvString);
}

// Helper function to write users back to CSV with file locking
function writeUsersToCSV(users) {
  lockfile
    .lock(csvFilePath, { retries: 3 }) // Attempt to lock the file before writing
    .then((release) => {
      const csvString = parse(users, { header: true });
      fs.writeFileSync(csvFilePath, csvString);
      release(); // Release the lock after writing is done
    })
    .catch((error) => {
      console.error('Error locking CSV file:', error);
    });
}

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

async function verifyPayment(reference) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${paystackSecretKey}` } }
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
          readUsersFromCSV().then((users) => {
            const updatedUsers = users.map((user) => {
              if (user.id === String(msg.from.id)) {
                user.payment_reference = paymentReference;
                user.status = 'true';
                user.subscription_start = new Date().toISOString();
              }
              return user;
            });

            writeUsersToCSV(updatedUsers);

            // Check if the group URL is still valid
            const groupUrl = 'https://t.me/+z0-HqT_ofAcwZTBk';
            axios
              .get(groupUrl)
              .then(() => {
                bot.sendMessage(
                  msg.chat.id,
                  'Payment verified successfully. You now have access to the VIP. Click the button below to join now.',
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: 'Join VIP Group',
                            url: groupUrl,
                          },
                        ],
                      ],
                    },
                  }
                );
              })
              .catch(() => {
                bot.sendMessage(
                  msg.chat.id,
                  'There seems to be an issue with the group link. Please contact support.'
                );
              });
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

    readUsersFromCSV()
      .then((users) => {
        const user = users.find((u) => u.id === String(message.chat.id));
        if (user) {
          let amount, currency;
          if (data === 'ghana') {
            amount = 488 * 100;
            currency = 'GHS';
          } else if (data === 'nigeria') {
            amount = 50000 * 100;
            currency = 'NGN';
          } else {
            amount = 50000 * 100;
            currency = 'NGN';
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
            })
            .catch((error) => {
              console.error(
                'Error creating Paystack payment link:',
                error.response ? error.response.data : error.message
              );
              bot.sendMessage(
                message.chat.id,
                'An error occurred while creating the payment link. Please try again later.'
              );
            });
        } else {
          bot.sendMessage(
            message.chat.id,
            'Email not found. Please click /start to register.'
          );
        }
      })
      .catch((error) => {
        console.error('Error reading from CSV:', error);
        bot.sendMessage(
          message.chat.id,
          'An error occurred while processing your request. Please try again.'
        );
      });
  }
});

async function checkSubscriptionAndSendPredictions() {
  const today = new Date();
  const users = await readUsersFromCSV();

  users.forEach((user) => {
    const subscriptionStart = new Date(user.subscription_start);
    const subscriptionEnd = new Date(subscriptionStart);
    subscriptionEnd.setDate(subscriptionEnd.getDate() + 30);

    if (subscriptionEnd > today && user.status === 'true') {
      bot.sendMessage(user.id, "Here is today's VIP prediction...");
    } else if (subscriptionEnd <= today && user.status === 'true') {
      user.status = 'false';
      writeUsersToCSV(users);
      bot.sendMessage(
        user.id,
        'Your subscription has expired. Click /subscribe to renew.'
      );
    }
  });
}

schedule.scheduleJob('0 9 * * *', checkSubscriptionAndSendPredictions);

console.log('Bot is running...');
