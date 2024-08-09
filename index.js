const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const app = express();

app.use(bodyParser.json());

// Replace with your Paystack webhook secret key
const paystackWebhookSecret = 'YOUR_PAYSTACK_WEBHOOK_SECRET';

app.post('/paystack-webhook', (req, res) => {
  const event = req.body;
  const signature = req.headers['x-paystack-signature'];

  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac('sha512', paystackWebhookSecret)
    .update(JSON.stringify(event))
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(400).send('Invalid signature');
  }

  // Process the webhook event
  if (event.event === 'charge.success') {
    const { email, reference } = event.data;

    // Find the user based on the email and update their payment reference
    updatePaymentReference(email, reference);
  }

  res.status(200).send('Webhook received');
});

function updatePaymentReference(email, reference) {
  const users = [];
  fs.createReadStream(csvFilePath)
    .pipe(csv())
    .on('data', (row) => {
      if (row.email === email) {
        row.payment_reference = reference;
      }
      users.push(row);
    })
    .on('end', () => {
      const csvString = parse(users, { header: true });
      fs.writeFileSync(csvFilePath, csvString);
    });
}

app.listen(3000, () => {
  console.log('Webhook server listening on port 3000');
});
