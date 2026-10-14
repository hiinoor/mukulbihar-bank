import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { Bank } from '../src/bank.js';
import { currentCode, codeAt, toBase32 } from '../src/otp.js';
import { extractDigits, parseIntent } from '../src/intent.js';

test('spoken digits and Hindi intents are recognized', () => {
  assert.equal(extractDigits('eight seven four two zero zero one two three four five six'), '874200123456');
  assert.equal(extractDigits('चार आठ दो नौ एक सात'), '482917');
  assert.equal(extractDigits('आद सात, चार, डो, शून्य, शून्य, एक, दो, तीन, चार, पाँच, चह.'), '874200123456');
  assert.deepEqual(parseIntent('मेरे पिछले तीन ट्रांजैक्शन बताओ'), { intent: 'transactions', count: 3 });
  assert.deepEqual(parseIntent('मेरा बेलेंस कितना है'), { intent: 'balance' });
  assert.deepEqual(parseIntent('block my card'), { intent: 'block_card' });
  assert.deepEqual(parseIntent('What is my name?'), { intent: 'name' });
  assert.deepEqual(parseIntent('I want to log in to my banking account'), { intent: 'login' });
  assert.deepEqual(parseIntent('Explain transactions to me'), { intent: 'unknown' });
  assert.deepEqual(parseIntent('What is a balance sheet?'), { intent: 'unknown' });
  assert.deepEqual(parseIntent('How can I make money?'), { intent: 'unknown' });
});

test('TOTP uses standard base32 secret and six digit output', () => {
  assert.equal(toBase32('48656c6c6f21deadbeef'), 'JBSWY3DP EHPK3PXP'.replaceAll(' ', ''));
  assert.match(codeAt('3132333435363738393031323334353637383930', 1), /^\d{6}$/);
});

test('repeated bad OTPs lock the account across new sessions', () => {
  const bank = new Bank(':memory:');
  try {
    const customer = bank.findCustomer('874200123456');
    const now = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) assert.equal(bank.authenticate(customer.id, 'bad', now), false);
    assert.equal(bank.authenticate(customer.id, currentCode(customer.otp_secret, now), now), false);
    const later = now + 5 * 60_000 + 1;
    assert.equal(bank.authenticate(customer.id, currentCode(customer.otp_secret, later), later), true);
  } finally { bank.close(); }
});

test('voice requests stay behind a session and use the selected language', async () => {
  let forwarded = '';
  let spoken = '';
  const whisper = createServer(async (req, res) => {
    for await (const chunk of req) forwarded += chunk.toString('latin1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'मेरा बैलेंस कितना है?' }));
  });
  whisper.listen(0, '127.0.0.1');
  await once(whisper, 'listening');
  const piper = createServer(async (req, res) => {
    for await (const chunk of req) spoken += chunk.toString();
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(Buffer.alloc(64));
  });
  piper.listen(0, '127.0.0.1');
  await once(piper, 'listening');
  const previous = process.env.WHISPER_URL;
  const previousPiper = process.env.PIPER_HI_URL;
  process.env.WHISPER_URL = `http://127.0.0.1:${whisper.address().port}/inference`;
  process.env.PIPER_HI_URL = `http://127.0.0.1:${piper.address().port}/synthesize`;
  const { server, bank } = createApp({ dbPath: ':memory:' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  try {
    assert.equal((await fetch(base + '/api/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav })).status, 401);
    const session = await fetch(base + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'hi-IN' }) });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/transcribe', { method: 'POST', headers: { cookie, 'content-type': 'audio/wav' }, body: 'invalid' })).status, 400);
    const result = await fetch(base + '/api/transcribe', { method: 'POST', headers: { cookie, 'content-type': 'audio/wav' }, body: wav });
    assert.deepEqual(await result.json(), { text: 'मेरा बैलेंस कितना है?', digits: '', credential: false });
    assert.match(forwarded, /name="language"\r\n\r\nhi/);
    assert.doesNotMatch(forwarded, /name="prompt"/);
    assert.match(forwarded, /filename="speech.wav"/);
    const speech = await fetch(base + '/api/speak', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'नमस्ते।' }) });
    assert.equal(speech.status, 200);
    assert.match(speech.headers.get('content-type'), /audio\/wav/);
    assert.match(spoken, /नमस्ते/);
  } finally {
    if (previous === undefined) delete process.env.WHISPER_URL;
    else process.env.WHISPER_URL = previous;
    if (previousPiper === undefined) delete process.env.PIPER_HI_URL;
    else process.env.PIPER_HI_URL = previousPiper;
    server.close(); whisper.close(); piper.close(); bank.close();
  }
});

test('authentication gates banking data and card blocking needs confirmation', async () => {
  const { server, bank } = createApp({ dbPath: ':memory:' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = async (path, data) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(data)
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Mukulbihar Bank/);

    const start = await post('/api/session', { language: 'en-US' });
    assert.equal(start.body.stage, 'account');
    const loginHelp = await post('/api/message', { text: 'I want to log in' });
    assert.match(loginHelp.body.reply, /enter your account number/);
    const nameBeforeOtp = await post('/api/message', { text: 'What is my name?' });
    assert.match(nameBeforeOtp.body.reply, /account number/);
    assert.doesNotMatch(nameBeforeOtp.body.reply, /Mukul Sharma/);
    const privateBeforeOtp = await post('/api/message', { text: 'balance' });
    assert.equal(privateBeforeOtp.status, 200);
    assert.match(privateBeforeOtp.body.reply, /account number/);
    assert.doesNotMatch(privateBeforeOtp.body.reply, /12,540/);
    assert.equal((await post('/api/identify', { accountNumber: '874200123456' })).body.stage, 'otp');
    assert.equal((await post('/api/verify', { code: '000000' })).body.ok, false);
    const customer = bank.findCustomer('874200123456');
    assert.equal(customer.name, 'Mukul Sharma');
    const login = await post('/api/verify', { code: currentCode(customer.otp_secret) });
    assert.equal(login.body.stage, 'ready');
    assert.equal(login.body.reply, 'Welcome, Mukul Sharma. Welcome back! How can I help you?');
    assert.equal((await post('/api/message', { text: 'What is my name?' })).body.reply, 'Your name is Mukul Sharma.');
    assert.equal(bank.authenticate(1, currentCode(customer.otp_secret)), false, 'an accepted code cannot be reused');
    assert.throws(() => bank.transactions(1, 6), /Count must be 1 to 5/);

    const balance = await post('/api/message', { text: 'What is my balance?' });
    assert.match(balance.body.reply, /12,540\.75/);
    await post('/api/language', { language: 'hi-IN' });
    const hindiBalance = await post('/api/message', { text: 'मेरा बैलेंस कितना है?' });
    assert.match(hindiBalance.body.reply, /आपका उपलब्ध बैलेंस/);
    assert.equal((await post('/api/message', { text: 'मेरा नाम क्या है?' })).body.reply, 'आपका नाम Mukul Sharma है।');
    await post('/api/language', { language: 'en-US' });
    const tx = await post('/api/message', { text: 'last three transactions' });
    assert.equal((tx.body.reply.match(/: /g) || []).length, 4);
    assert.equal(bank.card(1).status, 'ACTIVE');
    const pending = await post('/api/message', { text: 'block my card' });
    assert.equal(pending.body.expect, 'confirm');
    assert.equal(bank.card(1).status, 'ACTIVE');
    const cancelled = await post('/api/message', { text: 'cancel' });
    assert.match(cancelled.body.reply, /cancelled/);
    assert.equal(bank.card(1).status, 'ACTIVE');
    await post('/api/message', { text: 'block my card' });
    const unrelated = await post('/api/message', { text: 'yes, tell me a joke' });
    assert.equal(unrelated.body.expect, 'confirm');
    assert.equal(bank.card(1).status, 'ACTIVE');
    const confirmed = await post('/api/message', { text: 'confirm' });
    assert.match(confirmed.body.reply, /now blocked/);
    assert.equal(bank.card(1).status, 'BLOCKED');
    assert.equal((await post('/api/message', { text: 'block my card' })).body.reply.includes('already blocked'), true);
  } finally {
    server.close();
    bank.close();
  }
});

test('general questions work before and after verification without exposing credentials to the model', async () => {
  const modelCalls = [];
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/chat') {
      modelCalls.push(payload);
      const question = payload.messages.at(-1).content;
      const answer = question.includes('gravity') ? 'Gravity attracts objects with mass.' :
        question.includes('example') ? 'For example, gravity keeps the Moon near Earth.' :
        question.includes('long answer') ? 'Here is the first sentence with enough useful detail. Here is the second sentence with more detail for the listener. Here is an unrelated third sentence that must not be spoken.' : '';
      const intent = question.includes('cash is available') ? 'balance' : 'general';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: JSON.stringify({ intent, count: 5, answer }) } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const previousModel = process.env.OLLAMA_MODEL;
  const previousUrl = process.env.OLLAMA_URL;
  process.env.OLLAMA_MODEL = 'test-model';
  process.env.OLLAMA_URL = `http://127.0.0.1:${model.address().port}/api/chat`;
  const { server, bank } = createApp({ dbPath: ':memory:' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = async (path, data) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(data)
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  try {
    await post('/api/session', { language: 'en-US' });
    const first = await post('/api/message', { text: 'What is gravity?' });
    assert.equal(first.body.stage, 'account');
    assert.match(first.body.reply, /attracts objects/);
    const followup = await post('/api/message', { text: 'Can you give an example?' });
    assert.match(followup.body.reply, /Moon/);
    assert.ok(modelCalls[1].messages.some(message => message.role === 'assistant' && /attracts objects/.test(message.content)));
    const brief = await post('/api/message', { text: 'Give me a long answer' });
    assert.ok(brief.body.reply.length <= 170);
    assert.doesNotMatch(brief.body.reply, /third sentence/);
    const beforeOtp = await post('/api/message', { text: 'How much cash is available in my account?' });
    assert.match(beforeOtp.body.reply, /account number/);
    assert.doesNotMatch(beforeOtp.body.reply, /12,540/);
    await post('/api/identify', { accountNumber: '874200123456' });
    const callsBeforeCode = modelCalls.length;
    const codeInChat = await post('/api/message', { text: 'My OTP is one two three four five six' });
    assert.match(codeInChat.body.reply, /code by itself/);
    assert.equal(modelCalls.length, callsBeforeCode);
    const customer = bank.findCustomer('874200123456');
    await post('/api/verify', { code: currentCode(customer.otp_secret) });
    const balance = await post('/api/message', { text: 'How much cash is available in my account?' });
    assert.match(balance.body.reply, /12,540\.75/);
    const sensitive = await post('/api/message', { text: 'What does account 874200123456 mean?' });
    assert.equal(sensitive.status, 200);
    assert.ok(modelCalls.some(call => call.messages.at(-1).content.includes('[number removed]')));
    await post('/api/message', { text: 'My old code was one two three four five six. What now?' });
    assert.ok(modelCalls.at(-1).messages.at(-1).content.includes('[number removed]'));
    assert.ok(modelCalls.every(call => !JSON.stringify(call).includes(customer.otp_secret)));
  } finally {
    if (previousModel === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previousModel;
    if (previousUrl === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previousUrl;
    server.close(); bank.close(); model.close();
  }
});
