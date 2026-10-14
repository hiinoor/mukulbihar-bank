const numberWords = new Map([
  ['one',1],['two',2],['three',3],['four',4],['five',5],
  ['ek',1],['do',2],['teen',3],['char',4],['paanch',5],
  ['एक',1],['दो',2],['तीन',3],['चार',4],['पांच',5],['पाँच',5]
]);

export function parseIntent(text) {
  const value = String(text || '').toLowerCase().trim();
  if (/\b(?:my|mine)\b.{0,35}\bname\b|\bname\b.{0,35}\b(?:my|mine)\b|मेरा नाम|मेरे नाम/.test(value)) return { intent: 'name' };
  if (/\b(?:log\s?in|logging\s?in|sign\s?in|verify my account)\b|लॉग\s?इन|लॉगिन|साइन\s?इन/.test(value)) return { intent: 'login' };
  if (/\b(block|freeze|lost|stolen)\b|ब्लॉक|बंद|खो गया|चोरी/.test(value) && /card|कार्ड/.test(value)) return { intent: 'block_card' };
  const ownAccount = /\b(my|mine|account|last|latest|recent)\b|मेरा|मेरे|मेरी|खाता|खाते|पिछल/.test(value);
  if (/transaction|statement|लेनदेन|ट्रांजैक्शन/.test(value) && (ownAccount || /^(?:transactions?|statement|लेनदेन|ट्रांजैक्शन)[?.! ]*$/.test(value))) {
    const digit = value.match(/[1-5१-५]/)?.[0];
    const devanagari = '१२३४५';
    let count = digit ? (devanagari.includes(digit) ? devanagari.indexOf(digit) + 1 : Number(digit)) : null;
    if (!count) {
      for (const [word, n] of numberWords) {
        if (new RegExp(`(^|\\W)${word}(?=$|\\W)`).test(value)) { count = n; break; }
      }
    }
    return { intent: 'transactions', count: count || 5 };
  }
  if (!/balance sheet|बैलेंस शीट|बेलेंस शीट/.test(value) &&
      (/^(?:balance|बैलेंस|बेलेंस)[?.! ]*$/.test(value) ||
       (ownAccount && /balance|बैलेंस|बेलेंस|बैलेन्स|बेलन्स|शेष|बकाया|कितना पैसा|कितने पैसे/.test(value)))) return { intent: 'balance' };
  return { intent: 'unknown' };
}

export function extractDigits(text) {
  const digitWords = new Map([
    ['zero','0'],['one','1'],['two','2'],['three','3'],['four','4'],['five','5'],['six','6'],['seven','7'],['eight','8'],['nine','9'],
    ['shunya','0'],['ek','1'],['do','2'],['teen','3'],['char','4'],['paanch','5'],['chhe','6'],['saat','7'],['aath','8'],['nau','9'],
    ['शून्य','0'],['शोन्य','0'],['शोने','0'],['शुन्य','0'],['सून्य','0'],
    ['एक','1'],['दो','2'],['डो','2'],['तीन','3'],['चार','4'],
    ['पांच','5'],['पाँच','5'],['पाज','5'],['छह','6'],['छे','6'],['चे','6'],['चह','6'],
    ['सात','7'],['साथ','7'],['आठ','8'],['आद','8'],['अद','8'],['नौ','9']
  ]);
  const normalized = String(text).replace(/[०-९]/g, d => String('०१२३४५६७८९'.indexOf(d)))
    .replace(/शोन्यशोने|शून्यशून्य|शुन्यशुन्य/g, 'शून्य शून्य');
  const matches = normalized.toLowerCase().match(/[0-9]+|[a-z]+|[\u0900-\u097f]+/g) || [];
  return matches.map(part => /^\d+$/.test(part) ? part : (digitWords.get(part) || '')).join('');
}
