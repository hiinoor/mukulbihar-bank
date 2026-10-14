import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Bank } from './bank.js';
import { extractDigits, parseIntent } from './intent.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const authLifetimeMs = 10 * 60 * 1000;
const maxBodyBytes = 8192;
const maxAudioBytes = 1024 * 1024;

function copy(lang, en, hi) { return lang === 'hi-IN' ? hi : en; }
function money(paise, lang) {
  return new Intl.NumberFormat(lang === 'hi-IN' ? 'hi-IN' : 'en-IN', {
    style: 'currency', currency: 'INR'
  }).format(paise / 100);
}
function dateLabel(date, lang) {
  return new Intl.DateTimeFormat(lang === 'hi-IN' ? 'hi-IN' : 'en-IN', {
    day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata'
  }).format(new Date(date));
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(data));
}
function sessionCookie(req) {
  return /(?:^|; )mb_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function audioBody(req) {
  if (!/^audio\/(wav|wave|x-wav)(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('A WAV recording is required');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxAudioBytes) throw new Error('Recording is too long');
    chunks.push(chunk);
  }
  const wav = Buffer.concat(chunks);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' ||
      wav.toString('ascii', 12, 16) !== 'fmt ' || wav.readUInt16LE(20) !== 1 ||
      wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(34) !== 16 ||
      wav.toString('ascii', 36, 40) !== 'data') throw new Error('Recording must be 16 kHz mono PCM WAV');
  return wav;
}

export async function transcribeWithWhisper(wav, language, { digitsOnly = false, url = process.env.WHISPER_URL || 'http://127.0.0.1:8081/inference' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('language', language === 'hi-IN' ? 'hi' : 'en');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (digitsOnly) form.append('prompt', language === 'hi-IN'
    ? 'अंक बोलिए: शून्य, एक, दो, तीन, चार, पाँच, छह, सात, आठ, नौ.'
    : 'Digits: zero, one, two, three, four, five, six, seven, eight, nine.');
  const response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Local speech recognition is unavailable');
  const result = await response.json();
  return String(result.text || '').trim().slice(0, 500);
}
function redactCredentials(text) {
  const englishDigits = '(?:zero|one|two|three|four|five|six|seven|eight|nine)';
  const hindiDigits = '(?:शून्य|एक|दो|तीन|चार|पांच|पाँच|छह|सात|आठ|नौ)';
  return String(text)
    .replace(/(?:[\d०-९][\s-]?){6,}/g, '[number removed]')
    .replace(new RegExp(`\\b${englishDigits}(?:[\\s,.-]+${englishDigits}){5,}\\b`, 'gi'), '[number removed]')
    .replace(new RegExp(`${hindiDigits}(?:[\\s,.-]+${hindiDigits}){5,}`, 'g'), '[number removed]');
}
function likelySpokenDigits(text) {
  const words = String(text).toLowerCase().match(/[a-z]+|[\u0900-\u097f]+/g) || [];
  return extractDigits(text).length >= 3 && (!words.length || words.filter(word => extractDigits(word)).length >= words.length * 0.6);
}
function briefGeneralAnswer(text, lang) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = [...new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(clean)]
    .slice(0, 2).map(part => part.segment.trim());
  const answer = sentences.join(' ');
  if (answer.length <= 170) return answer;
  const cut = answer.slice(0, 170);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 100 ? cut.slice(0, lastSpace) : cut).replace(/[,:;—-]+$/, '')}…`;
}

export async function respondWithOllama(text, { lang = 'en-US', history = [] } = {}) {
  if (!process.env.OLLAMA_MODEL) return null;
  try {
    const response = await fetch(process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL, stream: false, format: 'json', keep_alive: -1,
        messages: [
          { role: 'system', content: `You are the helpful Mukulbihar Bank voice assistant. Answer general questions naturally and concisely in ${lang === 'hi-IN' ? 'Hindi' : 'US English'}. Return only JSON with keys "intent", "count", and "answer". Intent is "balance" only if the user asks for their own account balance, "transactions" only if asking for their own recent account transactions, "block_card" only if asking to block their own card, "name" only if asking for their own name, "login" if asking to log in, otherwise "general". Count is 1 to 5 for transactions, default 5. For a banking intent, leave answer empty; the secure backend will respond. For a general intent, answer in one or two short sentences, at most 25 words. Be direct. This app supports login with an account number followed by an authenticator code. Do not claim login is unavailable. You have no access to bank records, live information, or bank policies. Never invent personal account details, claim a banking action was completed, request a password or OTP, or include sensitive numbers. If asked directly whether this is a demo, answer honestly. If you do not know, say so.` },
          ...history.slice(-8),
          { role: 'user', content: redactCredentials(text) }
        ], options: { temperature: 0.3, num_predict: 130 }
      })
    });
    if (!response.ok) return null;
    const value = JSON.parse((await response.json()).message?.content || '{}');
    if (!['balance', 'transactions', 'block_card', 'name', 'login', 'general'].includes(value.intent)) return null;
    return {
      intent: value.intent,
      count: Number.isInteger(value.count) && value.count >= 1 && value.count <= 5 ? value.count : 5,
      answer: typeof value.answer === 'string' ? briefGeneralAnswer(value.answer, lang) : ''
    };
  } catch { return null; }
}

export function createApp({ dbPath = join(root, 'data', 'bank.sqlite') } = {}) {
  const bank = new Bank(dbPath);
  const sessions = new Map();
  let modelReady = false;
  if (process.env.OLLAMA_MODEL) {
    fetch(process.env.OLLAMA_URL?.replace('/api/chat', '/api/generate') || 'http://127.0.0.1:11434/api/generate', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL, prompt: 'Ready.', stream: false, keep_alive: -1, options: { num_predict: 1 } })
    }).then(response => { modelReady = response.ok; }).catch(() => {});
  }
  const server = createHttpServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const sid = sessionCookie(req);
    const session = sid && sessions.get(sid);
    const lang = session?.lang || 'en-US';
    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { ok: true, bank: 'Mukulbihar Bank', modelReady });
      }
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css', '/assets/voice-banking-home.png', '/assets/card-security-home.png'].includes(pathname)) {
        const file = pathname === '/' ? 'index.html' : pathname.slice(1);
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html';
        const contents = readFileSync(join(root, 'web', file));
        res.writeHead(200, { 'content-type': file.endsWith('.png') ? type : `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(contents);
      }
      if (req.method === 'POST' && pathname === '/api/session') {
        const data = await body(req);
        if (sid) sessions.delete(sid);
        const newSid = randomBytes(32).toString('hex');
        sessions.set(newSid, { lang: data.language === 'hi-IN' ? 'hi-IN' : 'en-US', stage: 'account', customerId: null, verifiedAt: 0, attempts: 0, pendingCard: null, history: [] });
        return json(res, 200, { stage: 'account', reply: copy(data.language, 'Welcome to Mukulbihar Bank. Ask me anything, or enter your account number for personal banking.', 'मुकुलबिहार बैंक में आपका स्वागत है। आप कोई भी सवाल पूछ सकते हैं, या निजी बैंकिंग के लिए अपना खाता नंबर बताइए।') }, {
          'set-cookie': `mb_session=${newSid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`
        });
      }
      if (!session) return json(res, 401, { error: 'Start a new conversation.' });
      if (req.method === 'POST' && pathname === '/api/speak') {
        const data = await body(req);
        const text = String(data.text || '').trim();
        if (!text || text.length > 1000) return json(res, 400, { error: 'Invalid speech text' });
        const speechUrl = session.lang === 'hi-IN'
          ? (process.env.PIPER_HI_URL || 'http://127.0.0.1:5002/synthesize')
          : (process.env.PIPER_EN_URL || 'http://127.0.0.1:5001/synthesize');
        try {
          const speech = await fetch(speechUrl, {
            method: 'POST', signal: AbortSignal.timeout(10000),
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text })
          });
          if (!speech.ok) throw new Error('Speech service failed');
          const wav = Buffer.from(await speech.arrayBuffer());
          if (wav.length < 44 || wav.length > 8 * 1024 * 1024) throw new Error('Invalid speech response');
          res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          return res.end(wav);
        } catch {
          return json(res, 503, { error: 'Local voice output is unavailable' });
        }
      }
      if (req.method === 'POST' && pathname === '/api/transcribe') {
        if (session.stage === 'locked') return json(res, 401, { error: 'Start a new conversation.' });
        const wav = await audioBody(req);
        try {
          const expectedDigits = session.stage === 'account' ? 12 : session.stage === 'otp' ? 6 : 0;
          let transcript = await transcribeWithWhisper(wav, session.lang);
          let digits = extractDigits(transcript);
          let credential = expectedDigits > 0 && (digits.length === expectedDigits || likelySpokenDigits(transcript));
          if (credential && digits.length !== expectedDigits) {
            const guided = await transcribeWithWhisper(wav, session.lang, { digitsOnly: true });
            const guidedDigits = extractDigits(guided);
            if (Math.abs(guidedDigits.length - expectedDigits) < Math.abs(digits.length - expectedDigits)) {
              transcript = guided;
              digits = guidedDigits;
            }
          }
          return json(res, 200, { text: transcript, digits: credential ? digits : '', credential });
        } catch {
          return json(res, 503, { error: 'Local speech recognition is unavailable. Please type your message.' });
        }
      }
      if (req.method === 'POST' && pathname === '/api/language') {
        const data = await body(req);
        session.lang = data.language === 'hi-IN' ? 'hi-IN' : 'en-US';
        return json(res, 200, { language: session.lang, reply: copy(session.lang, 'I will continue in English.', 'अब मैं हिंदी में बात करूँगी।') });
      }
      if (req.method === 'POST' && pathname === '/api/identify') {
        if (session.stage !== 'account') return json(res, 409, { error: 'Account identification is not expected now.' });
        const data = await body(req);
        const digits = extractDigits(data.accountNumber || '');
        const customer = bank.findCustomer(digits);
        if (!customer) return json(res, 200, { ok: false, stage: 'account', reply: copy(lang, 'I could not find that account. Please try again.', 'यह खाता नहीं मिला। कृपया फिर से बताइए।') });
        session.customerId = customer.id;
        session.stage = 'otp';
        return json(res, 200, { ok: true, stage: 'otp', reply: copy(lang, 'Please say the six digit code from your authenticator app.', 'कृपया अपने ऑथेंटिकेटर ऐप का छह अंकों वाला कोड बोलिए।') });
      }
      if (req.method === 'POST' && pathname === '/api/verify') {
        if (session.stage !== 'otp') return json(res, 409, { error: 'Verification is not expected now.' });
        const data = await body(req);
        const code = extractDigits(data.code || '');
        const valid = bank.authenticate(session.customerId, code);
        if (!valid) {
          session.attempts++;
          if (session.attempts >= 3) { session.stage = 'locked'; return json(res, 200, { ok: false, stage: 'locked', reply: copy(lang, 'Verification failed too many times. Please start a new conversation.', 'सत्यापन कई बार विफल हुआ। कृपया नई बातचीत शुरू करें।') }); }
          return json(res, 200, { ok: false, stage: 'otp', reply: copy(lang, 'That code did not work. Please try again.', 'यह कोड सही नहीं है। कृपया फिर से कोशिश करें।') });
        }
        session.stage = 'ready';
        session.verifiedAt = Date.now();
        const name = bank.customerName(session.customerId);
        return json(res, 200, { ok: true, stage: 'ready', reply: copy(lang,
          `Welcome, ${name}. Welcome back! How can I help you?`,
          `स्वागत है, ${name}। वापसी पर स्वागत है! मैं आपकी क्या सहायता करूँ?`) });
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        sessions.delete(sid);
        return json(res, 200, { ok: true }, { 'set-cookie': 'mb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'POST' && pathname === '/api/message') {
        const data = await body(req);
        const text = String(data.text || '').trim().slice(0, 500);
        if (!text.trim()) return json(res, 400, { error: 'Please say something.' });
        if (session.stage === 'locked') return json(res, 401, { error: 'Start a new conversation.' });
        if (session.stage === 'ready' && Date.now() - session.verifiedAt > authLifetimeMs) {
          session.stage = 'account';
          session.customerId = null;
          session.verifiedAt = 0;
          session.pendingCard = null;
          session.pendingCardId = null;
        }
        if (session.stage === 'otp' && extractDigits(text).length >= 6) {
          return json(res, 200, { stage: 'otp', expect: 'command', reply: copy(lang,
            'Please enter the six digit code by itself to verify your account.',
            'खाता सत्यापित करने के लिए केवल छह अंकों वाला कोड दर्ज करें।') });
        }
        if (session.pendingCard) {
          const confirmation = text.toLowerCase().replace(/[.!?।]+$/g, '').trim();
          if (/^(yes|confirm|yes confirm|okay confirm|हाँ|हां|पक्का|पुष्टि करें)$/.test(confirmation)) {
            session.pendingCard = null;
            const card = bank.blockCard(session.customerId, session.pendingCardId);
            session.pendingCardId = null;
            return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang,
              `Your ${card.network} card ending ${card.last_four} is now blocked.`,
              `आपका ${card.network} कार्ड, जिसके आखिरी चार अंक ${card.last_four} हैं, अब ब्लॉक हो गया है।`) });
          }
          if (/^(no|cancel|stop|don't|do not|नहीं|नही|रद्द)$/.test(confirmation)) {
            session.pendingCard = null;
            session.pendingCardId = null;
            return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang, 'I have cancelled the card block request.', 'कार्ड ब्लॉक करने का अनुरोध रद्द कर दिया गया है।') });
          }
        }
        let intent = parseIntent(text);
        let answer = '';
        if (intent.intent === 'unknown') {
          const model = await respondWithOllama(text, session);
          if (model) {
            modelReady = true;
            intent = model;
            answer = model.answer;
          }
        }
        if (intent.intent === 'login') {
          return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang,
            session.stage === 'ready' ? 'You are already verified. How can I help you?' : session.stage === 'otp' ? 'Please enter your six digit verification code to finish logging in.' : 'Please enter your account number to start verification.',
            session.stage === 'ready' ? 'आप पहले से सत्यापित हैं। मैं आपकी क्या सहायता करूँ?' : session.stage === 'otp' ? 'लॉग इन पूरा करने के लिए अपना छह अंकों वाला सत्यापन कोड दर्ज करें।' : 'सत्यापन शुरू करने के लिए अपना खाता नंबर दर्ज करें।') });
        }
        if (['balance', 'transactions', 'block_card', 'name'].includes(intent.intent) && session.stage !== 'ready') {
          return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang,
            session.stage === 'otp' ? 'Please enter your six digit verification code first.' : 'For personal banking, please enter your account number first.',
            session.stage === 'otp' ? 'पहले अपना छह अंकों वाला सत्यापन कोड दर्ज करें।' : 'निजी बैंकिंग के लिए पहले अपना खाता नंबर दर्ज करें।') });
        }
        if (intent.intent === 'name') {
          const name = bank.customerName(session.customerId);
          return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang,
            `Your name is ${name}.`, `आपका नाम ${name} है।`) });
        }
        if (intent.intent === 'balance') {
          const account = bank.balance(session.customerId);
          return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang,
            `Your available balance is ${money(account.balance_paise, lang)}.`,
            `आपका उपलब्ध बैलेंस ${money(account.balance_paise, lang)} है।`) });
        }
        if (intent.intent === 'transactions') {
          const count = Math.max(1, Math.min(5, intent.count || 5));
          const rows = bank.transactions(session.customerId, count);
          const parts = rows.map(row => copy(lang,
            `${dateLabel(row.posted_at, lang)}: ${row.description}, ${row.direction === 'debit' ? 'spent' : 'received'} ${money(row.amount_paise, lang)}.`,
            `${dateLabel(row.posted_at, lang)}: ${row.description}, ${row.direction === 'debit' ? 'खर्च' : 'प्राप्त'} ${money(row.amount_paise, lang)}।`));
          return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang, `Your last ${rows.length} transactions are: `, `आपके पिछले ${rows.length} लेनदेन हैं: `) + parts.join(' ') });
        }
        if (intent.intent === 'block_card') {
          const card = bank.card(session.customerId);
          if (!card) return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang, 'No card is available on this account.', 'इस खाते में कोई कार्ड उपलब्ध नहीं है।') });
          if (card.status === 'BLOCKED') return json(res, 200, { stage: session.stage, expect: 'command', reply: copy(lang, `Your ${card.network} card ending ${card.last_four} is already blocked.`, `आपका ${card.network} कार्ड, जिसके आखिरी चार अंक ${card.last_four} हैं, पहले से ब्लॉक है।`) });
          session.pendingCard = true;
          session.pendingCardId = card.id;
          return json(res, 200, { stage: session.stage, expect: 'confirm', reply: copy(lang,
            `Do you want to block your ${card.network} card ending ${card.last_four}? Please say confirm to proceed.`,
            `क्या आप अपना ${card.network} कार्ड, जिसके आखिरी चार अंक ${card.last_four} हैं, ब्लॉक करना चाहते हैं? पुष्टि के लिए हाँ कहें।`) });
        }
        if (!answer) answer = copy(lang,
          'General answers are temporarily unavailable. Please try again shortly.',
          'सामान्य सवालों के जवाब अभी उपलब्ध नहीं हैं। कृपया थोड़ी देर बाद फिर कोशिश करें।');
        else {
          session.history.push({ role: 'user', content: redactCredentials(text) }, { role: 'assistant', content: answer });
          session.history = session.history.slice(-8);
        }
        return json(res, 200, { stage: session.stage, expect: session.pendingCard ? 'confirm' : 'command', reply: answer });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      return json(res, /too large|too long/.test(error.message) ? 413 : 400, { error: error.message || 'Request failed' });
    }
  });
  return { server, bank };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server } = createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => console.log(`Mukulbihar Bank is running at http://127.0.0.1:${port}`));
}
