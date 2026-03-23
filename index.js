const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// 👇 responder imediatamente
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// 👇 MUITO IMPORTANTE
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
