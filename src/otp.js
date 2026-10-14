import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function newSecret() {
  return randomBytes(20).toString('hex');
}

export function toBase32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = Buffer.from(secret, 'hex');
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', Buffer.from(secret, 'hex')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

export function currentCode(secret, now = Date.now()) {
  return codeAt(secret, Math.floor(now / 30_000));
}

export function verifyCode(secret, input, lastUsedStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(input)) return null;
  const wanted = Buffer.from(input);
  const currentStep = Math.floor(now / 30_000);
  for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
    if (step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), wanted)) return step;
  }
  return null;
}
