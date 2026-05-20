const { PrismaClient } = require('../generated/prisma');
const axios = require('axios');
const crypto = require('crypto');
const p = new PrismaClient();

function decrypt(payload, secret) {
  // Mirrors src/common/utils/encryption.util.ts EncryptionUtil.decryptObject
  const SALT_LENGTH = 64, IV_LENGTH = 16, TAG_LENGTH = 16, KEY_LENGTH = 32, ITERATIONS = 100000;
  const buf = Buffer.from(payload, 'base64');
  const salt = buf.subarray(0, SALT_LENGTH);
  const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ct = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const key = crypto.pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

(async () => {
  const lead = await p.lead.findUnique({
    where: { id: 'eb14d4e1-ddc3-4121-8557-c8f90a9d35b3' },
  });
  if (!lead) throw new Error('lead missing');
  console.log('externalRequestId:', lead.externalRequestId);
  console.log('businessId:', lead.businessId);

  const sa = await p.savedAccount.findFirst({
    where: { businessId: lead.businessId, platform: 'yelp' },
    select: { id: true, businessName: true, credentialsJson: true },
  });
  if (!sa) throw new Error('saved account missing');
  console.log('account:', sa.businessName);

  const encKey = process.env.ENCRYPTION_KEY || '';
  if (!encKey) {
    console.log('ENCRYPTION_KEY env var missing — cannot decrypt credentials. Set it from Railway prod.');
    return;
  }
  const creds = decrypt(sa.credentialsJson, encKey);
  console.log('have accessToken:', !!creds.accessToken, 'expiresAt:', creds.expiresAt);

  const url = `https://api.yelp.com/v3/leads/${lead.externalRequestId}/events`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
  const events = resp.data?.events || [];
  console.log(`\nFetched ${events.length} events from Yelp.\n`);
  for (const ev of events) {
    console.log('---');
    console.log(`id=${ev.id} type=${ev.event_type} user_type=${ev.user_type} time=${ev.time_created} display_name=${ev.user_display_name ?? '-'}`);
    if (ev.id === 'kyISWzRFRELjTEPZlr9lrg') {
      console.log('  ⬆ MATCH — this is the May 5 mystery event');
      console.log('  Full event_content:', JSON.stringify(ev.event_content, null, 2));
      console.log('  Full event:', JSON.stringify(ev, null, 2));
    } else {
      const content = (ev.event_content?.text || ev.event_content?.fallback_text || '').substring(0, 200);
      if (content) console.log(`  content: ${content.replace(/\n/g, ' \\n ')}`);
    }
  }

  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message, e.response?.status, e.response?.data); process.exit(1); });
