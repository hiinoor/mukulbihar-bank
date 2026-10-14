import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newSecret, verifyCode } from './otp.js';

export class Bank {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, account_number TEXT NOT NULL UNIQUE,
        otp_secret TEXT NOT NULL, last_otp_step INTEGER NOT NULL DEFAULT -1
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        balance_paise INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR'
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
        description TEXT NOT NULL, amount_paise INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
        posted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        last_four TEXT NOT NULL, network TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','BLOCKED'))
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        action TEXT NOT NULL, detail TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_guard (
        customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
        failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (!this.db.prepare('SELECT id FROM customers LIMIT 1').get()) this.seed();
  }

  seed() {
    const secret = newSecret();
    this.db.prepare('INSERT INTO customers (id,name,account_number,otp_secret) VALUES (1,?,?,?)')
      .run('Mukul Sharma', '874200123456', secret);
    this.db.prepare('INSERT INTO accounts (id,customer_id,balance_paise) VALUES (1,1,?)').run(1254075);
    const insert = this.db.prepare('INSERT INTO transactions (account_id,description,amount_paise,direction,posted_at) VALUES (1,?,?,?,?)');
    const today = new Date();
    const txs = [
      ['Salary credit', 4800000, 'credit', 1],
      ['Metro card recharge', 50000, 'debit', 2],
      ['Grocery purchase', 185750, 'debit', 3],
      ['Electricity bill', 220000, 'debit', 5],
      ['Coffee House', 32000, 'debit', 6]
    ];
    for (const [description, amount, direction, daysAgo] of txs) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - daysAgo);
      insert.run(description, amount, direction, date.toISOString());
    }
    this.db.prepare("INSERT INTO cards (id,customer_id,last_four,network,status) VALUES (1,1,'4821','Visa','ACTIVE')").run();
  }

  findCustomer(accountNumber) {
    return this.db.prepare('SELECT id,name,account_number,otp_secret,last_otp_step FROM customers WHERE account_number=?').get(accountNumber);
  }

  customerName(customerId) {
    const customer = this.db.prepare('SELECT name FROM customers WHERE id=?').get(customerId);
    if (!customer) throw new Error('Customer unavailable');
    return customer.name;
  }

  authenticate(customerId, code, now = Date.now()) {
    const customer = this.db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
    if (!customer) return false;
    const guard = this.db.prepare('SELECT failures,locked_until FROM auth_guard WHERE customer_id=?').get(customerId) || { failures: 0, locked_until: 0 };
    if (guard.locked_until > now) return false;
    const step = verifyCode(customer.otp_secret, code, customer.last_otp_step, now);
    if (step === null) {
      const failures = guard.failures + 1;
      const lockedUntil = failures >= 3 ? now + 5 * 60_000 : 0;
      this.db.prepare('INSERT INTO auth_guard (customer_id,failures,locked_until) VALUES (?,?,?) ON CONFLICT(customer_id) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until')
        .run(customerId, failures >= 3 ? 0 : failures, lockedUntil);
      return false;
    }
    this.db.prepare('UPDATE customers SET last_otp_step=? WHERE id=?').run(step, customerId);
    this.db.prepare('INSERT INTO auth_guard (customer_id,failures,locked_until) VALUES (?,0,0) ON CONFLICT(customer_id) DO UPDATE SET failures=0,locked_until=0').run(customerId);
    this.audit(customerId, 'AUTH_SUCCESS', 'TOTP accepted');
    return true;
  }

  balance(customerId) {
    const row = this.db.prepare('SELECT balance_paise,currency FROM accounts WHERE customer_id=?').get(customerId);
    if (!row) throw new Error('Account unavailable');
    this.audit(customerId, 'BALANCE_VIEW', 'Balance read');
    return row;
  }

  transactions(customerId, count) {
    if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('Count must be 1 to 5');
    const rows = this.db.prepare(`SELECT t.description,t.amount_paise,t.direction,t.posted_at
      FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE a.customer_id=? ORDER BY t.posted_at DESC,t.id DESC LIMIT ?`).all(customerId, count);
    this.audit(customerId, 'TRANSACTIONS_VIEW', `count=${count}`);
    return rows;
  }

  card(customerId) {
    return this.db.prepare('SELECT id,last_four,network,status FROM cards WHERE customer_id=? ORDER BY id LIMIT 1').get(customerId);
  }

  blockCard(customerId, cardId) {
    const result = this.db.prepare("UPDATE cards SET status='BLOCKED' WHERE id=? AND customer_id=? AND status='ACTIVE'").run(cardId, customerId);
    const card = this.card(customerId);
    if (!card || card.id !== cardId) throw new Error('Card unavailable');
    this.audit(customerId, result.changes ? 'CARD_BLOCKED' : 'CARD_ALREADY_BLOCKED', `card=${cardId}`);
    return card;
  }

  audit(customerId, action, detail) {
    this.db.prepare('INSERT INTO audit_events (customer_id,action,detail,occurred_at) VALUES (?,?,?,?)')
      .run(customerId, action, detail, new Date().toISOString());
  }

  close() { this.db.close(); }
}
