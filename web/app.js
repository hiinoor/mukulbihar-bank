const $ = id => document.getElementById(id);
const els = {
  language: $('language'), messages: $('messages'), empty: $('empty-state'), start: $('start'),
  input: $('message-input'), form: $('message-form'), mic: $('mic'), send: $('send'),
  actions: $('quick-actions'), status: $('assistant-status'), hint: $('composer-hint'), toast: $('toast'), newChat: $('new-chat'), revealOtp: $('reveal-otp')
};
let stage = 'idle';
let busy = false;
let recorder = null;
let toastTimer = null;
let speechToken = 0;
let showOtp = false;
let speechRequest = null;
let audioPlayer = null;
let audioUrl = null;

function isHindi() { return els.language.value === 'hi-IN'; }
function phrase(en, hi) { return isHindi() ? hi : en; }
function notify(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4000);
}
function bubble(role, message) {
  if (els.empty) { els.empty.remove(); els.empty = null; }
  const box = document.createElement('div');
  box.className = `msg ${role === 'assistant' ? 'bot' : 'me'}`;
  box.textContent = message;
  els.messages.append(box);
  els.messages.scrollTop = els.messages.scrollHeight;
}
function voiceForLanguage() {
  const voices = window.speechSynthesis.getVoices();
  const language = els.language.value.toLowerCase();
  const preferred = isHindi() ? ['Lekha', 'Google हिन्दी'] : ['Samantha', 'Ava', 'Google US English'];
  return preferred.map(name => voices.find(v => v.name === name && v.lang.toLowerCase().startsWith(language.slice(0, 2)))).find(Boolean)
    || voices.find(v => v.lang.toLowerCase() === language && !/albert|bad news|bells|boing/i.test(v.name))
    || voices.find(v => v.lang.toLowerCase().startsWith(language.slice(0, 2)))
    || null;
}
function stopSpeech() {
  speechToken++;
  speechRequest?.abort();
  speechRequest = null;
  audioPlayer?.pause();
  audioPlayer = null;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  window.speechSynthesis?.cancel();
}
function speakBrowser(message, token) {
  if (!('speechSynthesis' in window)) return;
  const chunks = message.split(/(?<=[.!?।])\s+/).map(part => part.trim()).filter(Boolean);
  let index = 0;
  function next() {
    if (token !== speechToken || index >= chunks.length) return;
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    utterance.lang = els.language.value;
    utterance.rate = isHindi() ? 0.96 : 1;
    utterance.pitch = 1;
    const voice = voiceForLanguage();
    if (voice) utterance.voice = voice;
    utterance.onend = next;
    window.speechSynthesis.speak(utterance);
  }
  if (window.speechSynthesis.getVoices().length) next();
  else setTimeout(next, 250);
}
async function speak(message) {
  stopSpeech();
  const token = speechToken;
  const controller = new AbortController();
  speechRequest = controller;
  try {
    const response = await fetch('/api/speak', {
      method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: message })
    });
    if (!response.ok) throw new Error('Speech output unavailable');
    const blob = await response.blob();
    if (token !== speechToken) return;
    audioUrl = URL.createObjectURL(blob);
    audioPlayer = new Audio(audioUrl);
    audioPlayer.onended = () => {
      if (token === speechToken) {
        audioPlayer = null;
        URL.revokeObjectURL(audioUrl);
        audioUrl = null;
      }
    };
    await audioPlayer.play();
  } catch (error) {
    if (token === speechToken && error.name !== 'AbortError') speakBrowser(message, token);
  } finally {
    if (token === speechToken) speechRequest = null;
  }
}
function updateState(next) {
  if (next !== stage) showOtp = false;
  stage = next;
  const active = stage !== 'idle' && stage !== 'locked';
  els.input.disabled = !active;
  els.send.disabled = !active;
  els.mic.disabled = !active;
  els.newChat.hidden = stage === 'idle';
  els.actions.hidden = stage !== 'ready';
  els.input.type = stage === 'otp' && !showOtp && credentialInput(els.input.value)?.kind === 'otp' ? 'password' : 'text';
  els.revealOtp.hidden = stage !== 'otp';
  els.revealOtp.textContent = showOtp ? phrase('Hide', 'छिपाएँ') : phrase('Show', 'दिखाएँ');
  els.revealOtp.setAttribute('aria-label', showOtp ? phrase('Hide verification code', 'कोड छिपाएँ') : phrase('Show verification code', 'कोड दिखाएँ'));
  els.input.inputMode = 'text';
  els.input.placeholder = stage === 'account' ? phrase('Ask anything or enter account number', 'कुछ भी पूछें या खाता नंबर लिखें')
    : stage === 'otp' ? phrase('Ask anything or enter verification code', 'कुछ भी पूछें या सत्यापन कोड लिखें')
    : stage === 'ready' ? phrase('Ask me anything', 'मुझसे कुछ भी पूछें')
    : phrase('Start a conversation first', 'पहले बातचीत शुरू करें');
  els.status.innerHTML = `<span class="online-dot"></span> ${stage === 'ready' ? phrase('Verified and ready', 'सत्यापित और तैयार') : active ? phrase('Connected', 'कनेक्टेड') : phrase('Ready when you are', 'बातचीत के लिए तैयार')}`;
  els.hint.textContent = stage === 'otp'
    ? phrase('Ask a question, or speak your code, check the digits, then press Send.', 'सवाल पूछें, या कोड बोलें, अंक जाँचें, फिर भेजें दबाएँ।')
    : stage === 'account'
      ? phrase('Ask a question, or speak your account number, check the digits, then press Send.', 'सवाल पूछें, या खाता नंबर बोलें, अंक जाँचें, फिर भेजें दबाएँ।')
      : phrase('Use your microphone or type a message', 'माइक्रोफ़ोन इस्तेमाल करें या संदेश टाइप करें');
}
async function request(path, payload) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
async function start() {
  if (busy) return;
  busy = true;
  try {
    const result = await request('/api/session', { language: els.language.value });
    els.messages.replaceChildren();
    els.empty = null;
    bubble('assistant', result.reply); speak(result.reply); updateState(result.stage);
    els.input.focus();
  } catch (error) { notify(error.message); }
  finally { busy = false; }
}
function credentialInput(text) {
  if (stage !== 'account' && stage !== 'otp') return null;
  const digits = text.replace(/[०-९]/g, d => String('०१२३४५६७८९'.indexOf(d))).replace(/\D/g, '');
  const numericOnly = /^[\d०-९\s-]+$/.test(text.trim());
  const labelled = stage === 'account' ? /\baccount(?: number)?\b|खाता|अकाउंट/i.test(text)
    : /\b(?:otp|code|verification)\b|ओटीपी|कोड/i.test(text);
  if (!numericOnly && !(labelled && digits.length === (stage === 'account' ? 12 : 6))) return null;
  return { kind: stage, digits };
}
function displayUser(text, credential) {
  if (credential?.kind === 'otp') return '••••••';
  if (credential?.kind === 'account') return `•••• ${credential.digits.slice(-4)}`;
  return text;
}
async function submit(text) {
  if (busy || !text.trim() || stage === 'idle' || stage === 'locked') return;
  busy = true;
  stopSpeech();
  const credential = credentialInput(text);
  bubble('user', displayUser(text, credential));
  els.input.value = '';
  try {
    const endpoint = credential?.kind === 'account' ? '/api/identify' : credential?.kind === 'otp' ? '/api/verify' : '/api/message';
    const payload = credential?.kind === 'account' ? { accountNumber: credential.digits } : credential?.kind === 'otp' ? { code: credential.digits } : { text };
    const result = await request(endpoint, payload);
    bubble('assistant', result.reply);
    speak(result.reply);
    if (result.stage) updateState(result.stage);
    if (result.expect === 'confirm') els.input.placeholder = phrase('Say “confirm” or “cancel”', '“हाँ” या “रद्द” कहें');
  } catch (error) { notify(error.message); if (/expired|Start a new/.test(error.message)) updateState('locked'); }
  finally { busy = false; els.input.focus(); }
}
function wavFromSamples(chunks, sampleRate) {
  const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
  const ratio = sampleRate / 16000;
  const length = Math.floor(samples.length / ratio);
  const wav = new ArrayBuffer(44 + length * 2);
  const view = new DataView(wav);
  const write = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let value = 0;
    for (let j = start; j < end && j < samples.length; j++) value += samples[j];
    value = Math.max(-1, Math.min(1, value / (end - start)));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return wav;
}
async function finishRecording() {
  const current = recorder;
  if (!current) return;
  recorder = null;
  clearTimeout(current.timeout);
  current.source.disconnect(); current.processor.disconnect();
  current.stream.getTracks().forEach(track => track.stop());
  const sampleRate = current.context.sampleRate;
  await current.context.close();
  els.mic.classList.remove('listening');
  els.mic.setAttribute('aria-label', 'Speak');
  if (!current.heardSpeech) {
    notify(phrase('I did not hear speech. Please try again.', 'आवाज़ सुनाई नहीं दी। कृपया फिर कोशिश करें।'));
    return;
  }
  els.mic.disabled = true;
  els.status.textContent = phrase('Transcribing your voice…', 'आपकी आवाज़ लिखी जा रही है…');
  try {
    const response = await fetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'audio/wav' }, body: wavFromSamples(current.chunks.slice(Math.max(0, current.speechStart - 6)), sampleRate) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Transcription failed');
    const text = String((result.credential ? result.digits || result.text : result.text) || '').trim();
    if (!text) { notify(phrase('I could not make out the words. Please try again.', 'शब्द समझ नहीं आए। कृपया फिर कोशिश करें।')); return; }
    if (result.credential && (stage === 'account' || stage === 'otp')) {
      els.input.value = text;
      els.input.focus();
      const expected = stage === 'account' ? 12 : 6;
      const found = (result.digits || '').length;
      notify(found === expected
        ? phrase('Check the recognized digits, then press Send.', 'पहचाने गए अंक जाँचें, फिर भेजें दबाएँ।')
        : phrase(`I heard ${found} digits; please correct the ${expected}-digit number before sending.`, `${found} अंक पहचाने गए; भेजने से पहले ${expected} अंकों की संख्या ठीक करें।`));
    } else await submit(text);
  } catch (error) { notify(error.message); }
  finally { updateState(stage); }
}
async function listen() {
  if (recorder) { await finishRecording(); return; }
  if (busy) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    notify(phrase('Microphone is unavailable in this browser.', 'इस ब्राउज़र में माइक्रोफ़ोन उपलब्ध नहीं है।'));
    return;
  }
  stopSpeech();
  els.mic.disabled = true;
  let stream;
  let context;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const current = { stream, context, source, processor, chunks: [], heardSpeech: false, loudFrames: 0, speechStart: 0, lastSpeech: 0, started: performance.now(), timeout: null };
    recorder = current;
    processor.onaudioprocess = event => {
      if (recorder !== current) return;
      const samples = event.inputBuffer.getChannelData(0);
      current.chunks.push(new Float32Array(samples));
      let energy = 0;
      for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
      const loud = Math.sqrt(energy / samples.length) > 0.012;
      const now = performance.now();
      if (loud) {
        current.loudFrames++;
        if (current.loudFrames >= 3 && !current.heardSpeech) {
          current.heardSpeech = true;
          current.speechStart = current.chunks.length - 3;
        }
        current.lastSpeech = now;
      }
      if (current.heardSpeech && now - current.lastSpeech > (stage === 'account' || stage === 'otp' ? 1600 : 950)) finishRecording();
      else if (now - current.started > 15000 || (!current.heardSpeech && now - current.started > 5000)) finishRecording();
    };
    source.connect(processor); processor.connect(context.destination);
    current.timeout = setTimeout(finishRecording, 15500);
    els.mic.classList.add('listening');
    els.mic.setAttribute('aria-label', 'Stop listening');
    els.mic.disabled = false;
    els.status.textContent = phrase('Listening…', 'सुन रही हूँ…');
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') await context.close();
    els.mic.disabled = false;
    notify(error.name === 'NotAllowedError' ? phrase('Allow microphone access to speak.', 'बोलने के लिए माइक्रोफ़ोन की अनुमति दें।') : error.message);
  }
}

els.start.addEventListener('click', start);
els.newChat.addEventListener('click', start);
els.form.addEventListener('submit', event => { event.preventDefault(); submit(els.input.value); });
els.input.addEventListener('input', () => {
  if (stage === 'otp') els.input.type = !showOtp && credentialInput(els.input.value)?.kind === 'otp' ? 'password' : 'text';
});
els.mic.addEventListener('click', listen);
els.revealOtp.addEventListener('click', () => { showOtp = !showOtp; updateState(stage); els.input.focus(); });
els.actions.addEventListener('click', event => {
  const button = event.target.closest('[data-command]');
  const command = button && (isHindi() ? button.dataset.commandHi : button.dataset.command);
  if (command) submit(command);
});
els.language.addEventListener('change', async () => {
  document.documentElement.lang = els.language.value;
  const key = isHindi() ? 'hi' : 'en';
  document.querySelectorAll('[data-en][data-hi]').forEach(node => { node.textContent = node.dataset[key]; });
  if (stage === 'idle') { updateState('idle'); return; }
  try {
    const result = await request('/api/language', { language: els.language.value });
    bubble('assistant', result.reply); speak(result.reply); updateState(stage);
  } catch (error) { notify(error.message); }
});
updateState('idle');

const revealNodes = [...document.querySelectorAll('.reveal')];
if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
  revealNodes.forEach(node => node.classList.add('is-visible'));
} else {
  document.documentElement.classList.add('js-ready');
  const revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -35px 0px' });
  revealNodes.forEach(node => revealObserver.observe(node));
}

function openAgent() {
  document.getElementById('live-agent').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (stage === 'idle') start();
  else els.input.focus();
}
document.getElementById('headerActionBtn').addEventListener('click', openAgent);
document.querySelectorAll('[data-start-agent]').forEach(button => button.addEventListener('click', openAgent));
