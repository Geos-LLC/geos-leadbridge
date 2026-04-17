const { PrismaClient } = require('../generated/prisma');
const { EncryptionUtil } = require('../dist/common/utils/encryption.util');
const axios = require('axios');
const prisma = new PrismaClient();

async function fixBrokenLeads() {
  const key = process.env.ENCRYPTION_KEY || '';

  // Get Jacksonville account with refreshed token
  const account = await prisma.savedAccount.findFirst({
    where: { platform: 'yelp', businessId: 'bATU27M80b_VRB2Ge8fA7A' },
  });
  if (!account?.credentialsJson) { console.log('No account found'); return; }

  const creds = EncryptionUtil.decryptObject(account.credentialsJson, key);
  console.log('Token expires:', creds.expiresAt);

  // Find broken leads
  const broken = await prisma.lead.findMany({
    where: { platform: 'yelp', customerName: 'Unknown', businessId: 'bATU27M80b_VRB2Ge8fA7A' },
  });
  console.log(`Found ${broken.length} broken leads to fix`);

  for (const lead of broken) {
    console.log(`\nFixing: ${lead.externalRequestId}`);
    try {
      // Fetch lead from Yelp API
      const res = await axios.get(`https://api.yelp.com/v3/leads/${lead.externalRequestId}`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      const data = res.data;

      // Extract name
      const name = data.user?.display_name || 'Unknown';

      // Fetch events for message
      let message = '';
      try {
        const evRes = await axios.get(`https://api.yelp.com/v3/leads/${lead.externalRequestId}/events`, {
          headers: { Authorization: `Bearer ${creds.accessToken}` },
        });
        const events = evRes.data?.events || [];
        const firstMsg = events.find(e => e.user_type === 'CONSUMER' && (e.event_type === 'TEXT' || e.event_type === 'RAQ_SUBMIT'));
        message = firstMsg?.event_content?.text || firstMsg?.event_content?.fallback_text || '';
        // Strip boilerplate
        message = message
          .replace(/^Hi there[,!].*?(?:regarding my project|questions regarding my project):\s*/s, '')
          .replace(/^Hi there[,!].*?(?:please respond with a price estimate\.)?\s*(?:Here are my answers to Yelp's questions regarding my project:\s*)?/si, '')
          .trim();
      } catch (e) {
        console.log('  Events fetch failed:', e.message);
      }

      // Extract category, location, phone
      const category = data.project?.job_names?.[0] || data.category || null;
      const city = data.project?.location?.city || null;
      const state = data.project?.location?.state || null;
      const postcode = data.project?.location?.postal_code || null;
      const phone = data.user?.phone || null;

      // Update lead
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          customerName: name,
          message: message || null,
          category,
          city,
          state,
          postcode,
          customerPhone: phone || undefined,
          rawJson: JSON.stringify(data),
        },
      });
      console.log(`  Fixed: ${name} | ${category} | ${city}`);
    } catch (err) {
      console.log(`  FAILED: ${err.response?.status || err.message}`);
    }
  }

  await prisma.$disconnect();
}

fixBrokenLeads();
