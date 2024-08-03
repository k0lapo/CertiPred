const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

app.post('/paystack-webhook', (req, res) => {
  const event = req.body;

  // Handle the Paystack event
  console.log('Received event:', event);

  res.status(200).send('Event received');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
