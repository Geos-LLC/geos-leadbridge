const { PrismaClient } = require('./generated/prisma');
const prisma = new PrismaClient();

const failedNegotiationIds = [
  '542396448390373391',
  '542388348291538946', 
  '542352633458475023',
  '542337526641434643'
];

async function checkConversations() {
  console.log('Checking failed conversation imports...\n');
  
  for (const negId of failedNegotiationIds) {
    console.log(`\n=== Negotiation ID: ${negId} ===`);
    
    // Check if lead exists
    const lead = await prisma.lead.findFirst({
      where: { externalRequestId: negId },
      include: {
        conversation: {
          include: {
            messages: {
              orderBy: { sentAt: 'asc' },
              take: 5
            }
          }
        }
      }
    });
    
    if (lead) {
      console.log('✅ Lead exists in database');
      console.log(`   ID: ${lead.id}`);
      console.log(`   Customer: ${lead.customerName}`);
      console.log(`   Category: ${lead.category}`);
      console.log(`   Created: ${lead.createdAt}`);
      console.log(`   Status: ${lead.status}`);
      console.log(`   Thread ID: ${lead.threadId}`);
      
      if (lead.conversation) {
        console.log(`   ✅ Conversation exists (showing first 5 messages)`);
        console.log(`   Conversation ID: ${lead.conversation.id}`);
        console.log(`   Messages count: ${lead.conversation.messageCount}`);
        console.log(`   Last message: ${lead.conversation.lastMessageAt}`);
      } else {
        console.log(`   ❌ No conversation found (threadId: ${lead.threadId})`);
      }
    } else {
      console.log('❌ Lead NOT found in database');
      console.log('   This negotiation was never successfully imported');
    }
  }
  
  await prisma.$disconnect();
}

checkConversations().catch(console.error);
