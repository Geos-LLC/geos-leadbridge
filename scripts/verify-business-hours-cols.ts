import 'dotenv/config';
process.env.DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
import { PrismaClient } from '../generated/prisma';

const p = new PrismaClient();
(async () => {
  const userCols: any[] = await p.$queryRawUnsafe(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name='users' AND column_name LIKE 'business_hours%'
    ORDER BY column_name`);
  const acctCols: any[] = await p.$queryRawUnsafe(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name='saved_accounts'
      AND column_name IN ('business_hours_override','call_during_business_hours','first_msg_during_business_hours','follow_ups_use_business_hours','ai_conversation_mode')
    ORDER BY column_name`);
  console.log('users new columns:');
  console.table(userCols);
  console.log('saved_accounts new columns:');
  console.table(acctCols);
  await p.$disconnect();
})();
