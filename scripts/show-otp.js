import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentCode, toBase32 } from '../src/otp.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = new DatabaseSync(join(root, 'data', 'bank.sqlite'));
const customer = db.prepare('SELECT account_number,otp_secret FROM customers ORDER BY id LIMIT 1').get();
if (!customer) throw new Error('Start the server once to create the account.');
console.log(`Account: ${customer.account_number}`);
console.log(`Current OTP: ${currentCode(customer.otp_secret)}`);
const key = toBase32(customer.otp_secret);
console.log(`Authenticator setup key: ${key}`);
console.log(`Authenticator URI: otpauth://totp/Mukulbihar%20Bank:${customer.account_number}?secret=${key}&issuer=Mukulbihar%20Bank&algorithm=SHA1&digits=6&period=30`);
db.close();
