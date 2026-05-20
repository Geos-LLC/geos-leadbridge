const { PrismaClient } = require('../generated/prisma');
const axios = require('axios');
const crypto = require('crypto');
const p = new PrismaClient();

function decrypt(payload, secret) {
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
  const encKey = process.env.ENCRYPTION_KEY || '';

  // Fetch all empty-content yelp customer rows
  const rows = await p.message.findMany({
    where: { platform: 'yelp', sender: 'customer', rawJson: null, content: '' },
    orderBy: { sentAt: 'desc' },
  });
  console.log(`Total empty-content yelp+customer rows: ${rows.length}\n`);

  // Group by thread; also pull lead info to map ext id → actual Yelp event
  const byThread = new Map();
  for (const r of rows) {
    if (!byThread.has(r.conversationId)) byThread.set(r.conversationId, []);
    byThread.get(r.conversationId).push(r);
  }
  console.log(`Across ${byThread.size} threads.\n`);

  // For up to 5 unique threads, fetch Yelp events to verify what these external IDs really are
  let inspected = 0;
  for (const [threadId, msgs] of byThread) {
    if (inspected >= 5) break;
    inspected++;
    console.log(`\n=== Thread ${threadId} (${msgs.length} empty rows) ===`);

    // Find the lead for this thread
    const lead = await p.lead.findFirst({
      where: { threadId },
      select: { id: true, customerName: true, externalRequestId: true, businessId: true, userId: true, platform: true, status: true },
    });
    if (!lead) { console.log('  No lead found'); continue; }
    console.log(`  Lead: ${lead.customerName} (${lead.externalRequestId}), status=${lead.status}, business=${lead.businessId}`);

    // Print the empty rows
    for (const m of msgs) {
      console.log(`  empty msg: ${m.sentAt?.toISOString()} ext=${m.externalMessageId} msMs=${m.sentAt?.getMilliseconds()} senderType=${m.senderType ?? '-'}`);
    }

    // Pull all messages on this thread (any sender) sandwiching the empty rows — context
    const all = await p.message.findMany({
      where: { conversationId: threadId },
      orderBy: { sentAt: 'asc' },
      select: { id: true, sender: true, senderType: true, content: true, sentAt: true, externalMessageId: true, rawJson: true },
    });
    console.log(`  Full thread context (${all.length} messages):`);
    for (const m of all) {
      const mark = msgs.some(x => x.id === m.id) ? '⚠⚠' : '  ';
      const c = (m.content || '').substring(0, 80).replace(/\n/g, ' \\n ');
      console.log(`  ${mark} ${m.sentAt?.toISOString()} ${m.sender}/${m.senderType ?? '-'} ext=${m.externalMessageId ?? 'NULL'} hasRaw=${!!m.rawJson} "${c}"`);
    }

    // Fetch Yelp events for this lead to see what these IDs actually are
    if (encKey && lead.businessId) {
      try {
        const sa = await p.savedAccount.findFirst({
          where: { businessId: lead.businessId, platform: 'yelp' },
          select: { credentialsJson: true },
        });
        if (sa?.credentialsJson) {
          const creds = decrypt(sa.credentialsJson, encKey);
          const url = `https://api.yelp.com/v3/leads/${lead.externalRequestId}/events`;
          const resp = await axios.get(url, { headers: { Authorization: `Bearer ${creds.accessToken}` }, timeout: 15000 });
          const events = resp.data?.events || [];
          console.log(`  Yelp says ${events.length} events on this lead:`);
          for (const ev of events) {
            const isEmpty = msgs.find(m => m.externalMessageId === ev.id);
            const mark = isEmpty ? '⚠⚠' : '  ';
            const c = (ev.event_content?.text || ev.event_content?.fallback_text || JSON.stringify(ev.event_content || {})).substring(0, 80).replace(/\n/g, ' \\n ');
            console.log(`  ${mark} id=${ev.id} type=${ev.event_type} user_type=${ev.user_type} time=${ev.time_created} content="${c}"`);
          }
        }
      } catch (err) {
        console.log(`  Yelp fetch err: ${err.message}`);
      }
    }
  }

  // Frequency breakdown by date (just the date part)
  console.log('\n\n=== Date distribution ===');
  const byDate = new Map();
  for (const r of rows) {
    const d = r.sentAt?.toISOString().slice(0, 10);
    byDate.set(d, (byDate.get(d) || 0) + 1);
  }
  const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [d, n] of sorted) console.log(`  ${d}: ${n}`);

  // userId breakdown
  console.log('\n=== userId distribution ===');
  const byUser = new Map();
  for (const r of rows) {
    const u = r.userId || 'null';
    byUser.set(u, (byUser.get(u) || 0) + 1);
  }
  for (const [u, n] of byUser) console.log(`  ${u}: ${n}`);

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
