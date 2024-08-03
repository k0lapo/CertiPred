const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const csv = require('csv-parser');
const { parse } = require('json2csv');
const axios = require('axios');

// Replace with your bot token
const token =
  process.env.TELEGRAM_BOT_TOKEN ||
  '7423465518:AAE9PLXR0teojJXrZZSXY7n1boqk58IDeDQ';
const bot = new TelegramBot(token, { polling: true });
const groupId = process.env.TELEGRAM_GROUP_ID || '1002246126147';
// Paystack secret key
const paystackSecretKey = 'sk_test_a4fff27f8d07dde60e45065d6baf5accb9c99bf1';

// CSV file path
const csvFilePath = 'users.csv';

// Ensure the CSV file exists
if (!fs.existsSync(csvFilePath)) {
  fs.writeFileSync(
    csvFilePath,
    'id,username,first_name,last_name,email,status,payment_reference\n'
  );
}

// Listen for '/start' command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, 'Please provide your email address:');

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
        payment_reference: '', // Initialize as an empty string
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
              'You have been registered successfully. Type /subscribe to continue.'
            );
          } else {
            bot.sendMessage(
              chatId,
              'Welcome back. Type /subscribe to continue.'
            );
          }
        });
    } else {
      bot.sendMessage(
        chatId,
        'Invalid email address. Please type /start to try again.'
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

  if (data === 'made_payment') {
    await bot.sendMessage(
      message.chat.id,
      'Please enter your payment reference:'
    );

    bot.once('message', async (msg) => {
      if (msg.text && !msg.text.startsWith('/')) {
        const paymentReference = msg.text;

        // Find and update the user's payment reference in the CSV
        const users = [];
        fs.createReadStream(csvFilePath)
          .pipe(csv())
          .on('data', (row) => {
            if (row.id === String(msg.from.id)) {
              row.payment_reference = paymentReference;
            }
            users.push(row);
          })
          .on('end', () => {
            const csvString = parse(users, { header: true });
            fs.writeFileSync(csvFilePath, csvString);
            bot.sendMessage(
              msg.chat.id,
              'We are processing your payment. Please check back.'
            );
          });
      }
    });
  } else {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(message.chat.id, `You selected: ${data}`);

    // Read user email from CSV
    const userEmail = await getUserEmail(message.chat.id);
    if (userEmail) {
      console.log('Retrieved email:', userEmail); // Debugging log
      try {
        // Create a Paystack payment link
        const response = await axios.post(
          'https://api.paystack.co/transaction/initialize',
          {
            email: userEmail, // Use user's email
            amount: 50000 * 100, // Amount in kobo
            currency: 'NGN',
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
          `The price for VIP subscription is N50,000 for 30 days. Please make the payment using the link below: ${paymentUrl}`
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
          'An error occurred while creating the payment link. Please try again later.'
        );
      }
    } else {
      await bot.sendMessage(
        message.chat.id,
        'Email not found. Please type /start to register.'
      );
    }
  }
});

// Listen for '/admin' command
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;

  // Read users from CSV and generate admin panel
  const users = [];
  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => {
      users.push(row);
    })
    .on('end', () => {
      let adminMessage = 'User Management:\n\n';
      users.forEach((user, index) => {
        adminMessage += `${index + 1}. ${user.first_name} ${user.last_name} (@${
          user.username
        }) - Email: ${user.email} - Payment Ref: ${
          user.payment_reference
        } - Status: ${user.status}\n`;
        adminMessage += `/toggle_${user.id} - Toggle Status\n`;
      });

      bot.sendMessage(chatId, adminMessage);
    });
});

// Handle status toggle and user removal commands
bot.onText(/\/toggle_(\d+)/, (msg, match) => {
  const userId = match[1];
  updateUserStatus(userId, msg.chat.id);
});

// Function to update user status
function updateUserStatus(userId, chatId) {
  const users = [];

  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => {
      if (row.id === userId) {
        row.status = row.status === 'true' ? 'false' : 'true';
      }
      users.push(row);
    })
    .on('end', () => {
      const csvString = parse(users, { header: true });
      fs.writeFileSync(csvFilePath, csvString);
      bot.sendMessage(chatId, `User status updated successfully.`);
    });
}

// Function to remove unauthorized members
function removeUnauthorizedMembers() {
  const usersToBan = [];

  // Read the CSV file and identify users with 'false' status
  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => {
      // Check if the 'status' field exists and is set to 'false'
      if (row.status && row.status.toLowerCase() === 'false') {
        usersToBan.push(row);
      }
    })
    .on('end', async () => {
      console.log('Users with false status:', usersToBan);

      // Loop through the users with false status
      for (const user of usersToBan) {
        try {
          // Send a message to the user
          await bot.sendMessage(
            user.id,
            'You are not allowed to stay in the group unless you are a paid user.'
          );

          // Ban the user from the group
          await bot.banChatMember(groupId, user.id);

          console.log(`Banned user: ${user.username}`);
        } catch (error) {
          console.error(`Failed to ban user ${user.username}:`, error);
        }
      }
    });
}

// Schedule to check and remove unauthorized members every 1 hour
setInterval(removeUnauthorizedMembers, 60 * 60 * 1000); // Runs every 1 hour

// Immediately run the function to check and remove unauthorized members
removeUnauthorizedMembers();

// Function to get user email from CSV
async function getUserEmail(userId) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        if (row.id === String(userId)) {
          resolve(row.email);
        }
      })
      .on('end', () => {
        resolve(null); // Email not found
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}
