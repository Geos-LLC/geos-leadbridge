const { PrismaClient } = require('./generated/prisma');
const prisma = new PrismaClient();

async function main() {
  // Target user (info@spotless.homes)
  const targetUserId = '263df66c-4034-4c6c-9fdd-b25eb75dfe16';

  // Move the 2 leads from test2@example.com to info@spotless.homes
  const result = await prisma.lead.updateMany({
    where: {
      businessId: '536718086694412297',
      userId: 'e7e3b246-4c08-49a5-a20c-8fe656fc7b47' // test2@example.com
    },
    data: {
      userId: targetUserId
    }
  });
  console.log('Moved', result.count, 'leads to info@spotless.homes');

  // Delete the test users
  const deleteTest1 = await prisma.user.deleteMany({
    where: { email: 'test@example.com' }
  });
  console.log('Deleted test@example.com:', deleteTest1.count);

  const deleteTest2 = await prisma.user.deleteMany({
    where: { email: 'test2@example.com' }
  });
  console.log('Deleted test2@example.com:', deleteTest2.count);

  // Verify leads now
  const leads = await prisma.lead.findMany({
    where: { businessId: '536718086694412297' },
    select: { customerName: true, userId: true }
  });
  console.log('\n=== LEADS FOR 536718086694412297 ===');
  console.log('Count:', leads.length);
  leads.forEach(l => console.log(' -', l.customerName, '| userId:', l.userId));
}

main().catch(console.error).finally(() => prisma.$disconnect());
