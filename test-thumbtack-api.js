require('dotenv').config();
const { PrismaClient } = require('./generated/prisma');
const axios = require('axios');
const crypto = require('crypto');
const prisma = new PrismaClient();

// Encryption utility (copied from backend)
class EncryptionUtil {
  static decrypt(encryptedData, secret) {
    const ALGORITHM = 'aes-256-gcm';
    const IV_LENGTH = 16;
    const SALT_LENGTH = 64;
    const TAG_LENGTH = 16;
    const KEY_LENGTH = 32;
    const ITERATIONS = 100000;

    const buffer = Buffer.from(encryptedData, 'base64');

    const salt = buffer.subarray(0, SALT_LENGTH);
    const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    const key = crypto.pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  static decryptObject(encryptedData, secret) {
    const decrypted = this.decrypt(encryptedData, secret);
    return JSON.parse(decrypted);
  }
}

async function testThumbtackAPI() {
  // Get saved account credentials
  const account = await prisma.savedAccount.findFirst({
    where: {
      platform: 'thumbtack'
    }
  });

  if (!account) {
    console.log('No Thumbtack account found');
    return;
  }

  console.log('Found account:', account.businessName);

  // Decrypt credentials
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.log('ERROR: ENCRYPTION_KEY not found in environment');
    await prisma.$disconnect();
    return;
  }

  const credentials = EncryptionUtil.decryptObject(account.credentialsJson, encryptionKey);
  console.log('Access token:', credentials.accessToken.substring(0, 20) + '...');
  console.log('Token expires:', credentials.expiresAt);
  console.log('');

  // Recent failed IDs from the latest batch
  const failedIds = [
    '546570939895750656', // Failed in recent batch
    '542396448390373391',
    '542388348291538946',
    '542352633458475023',
    '542337526641434643'
  ];

  // Test each failed ID
  for (const testId of failedIds) {
    console.log('\n===========================================');
    console.log('Testing negotiation ID:', testId);
    console.log('URL: https://api.thumbtack.com/api/v4/negotiations/' + testId);
    console.log('===========================================\n');

    try {
      const response = await axios.get(
        `https://api.thumbtack.com/api/v4/negotiations/${testId}`,
        {
          headers: {
            'Authorization': `Bearer ${credentials.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      console.log('✅ SUCCESS - Response:');
      console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
      console.log('❌ ERROR - Status:', error.response?.status);
      console.log('Error data:');
      console.log(JSON.stringify(error.response?.data, null, 2));
      console.log('');
      console.log('Full error message:', error.message);

      if (error.response?.status === 500) {
        console.log('\n⚠️  This is a Thumbtack API internal server error');
        console.log('The negotiation ID may be corrupted in Thumbtack\'s database');
      }
    }
  }

  await prisma.$disconnect();
}

testThumbtackAPI().catch(console.error);
