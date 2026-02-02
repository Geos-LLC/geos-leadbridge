require('dotenv').config();
const { PrismaClient } = require('./generated/prisma');
const prisma = new PrismaClient();

async function checkLeadData() {
  // Get a recent lead with rawJson
  const lead = await prisma.lead.findFirst({
    orderBy: { createdAt: 'desc' }
  });

  if (!lead) {
    console.log('No leads found');
    return;
  }

  console.log('Lead ID:', lead.id);
  console.log('Category:', lead.category);
  console.log('\nRaw JSON structure:');
  
  const raw = JSON.parse(lead.rawJson);
  console.log('\nRequest object keys:', Object.keys(raw.request || {}));
  console.log('\nRequest.details:', JSON.stringify(raw.request?.details, null, 2));
  
  await prisma.$disconnect();
}

checkLeadData().catch(console.error);
