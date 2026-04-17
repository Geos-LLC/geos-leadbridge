const { PrismaClient } = require('../generated/prisma');
const { EncryptionUtil } = require('../dist/common/utils/encryption.util');
const axios = require('axios');
const prisma = new PrismaClient();

(async () => {
  const key = process.env.ENCRYPTION_KEY || '';

  const accounts = await prisma.savedAccount.findMany({
    where: { platform: 'yelp' },
    select: { id: true, businessId: true, businessName: true, credentialsJson: true },
  });

  for (const a of accounts) {
    if (!a.credentialsJson) continue;
    let creds;
    try {
      creds = EncryptionUtil.decryptObject(a.credentialsJson, key);
    } catch (e) {
      console.log(a.businessName, '| decrypt failed:', e.message);
      continue;
    }

    // Test the token against partner API
    try {
      await axios.get('https://partner-api.yelp.com/token/v1/businesses', {
        headers: { Authorization: 'Bearer ' + creds.accessToken },
      });
      console.log(a.businessName, '| token VALID');
    } catch (e) {
      console.log(a.businessName, '| token INVALID:', e.response?.status, e.response?.data?.error?.code || e.message);

      if (creds.refreshToken) {
        try {
          const clientId = process.env.YELP_CLIENT_ID || '';
          const clientSecret = process.env.YELP_CLIENT_SECRET || '';
          const params = new URLSearchParams();
          params.append('grant_type', 'refresh_token');
          params.append('client_id', clientId);
          params.append('client_secret', clientSecret);
          params.append('refresh_token', creds.refreshToken);
          const refreshRes = await axios.post('https://api.yelp.com/oauth2/token', params);
          const newToken = refreshRes.data.access_token;
          const newRefresh = refreshRes.data.refresh_token || creds.refreshToken;
          const expiresIn = refreshRes.data.expires_in || 604800;
          const expiresAt = new Date(Date.now() + expiresIn * 1000);

          const updatedCreds = { ...creds, accessToken: newToken, refreshToken: newRefresh, expiresAt };
          await prisma.savedAccount.update({
            where: { id: a.id },
            data: { credentialsJson: EncryptionUtil.encryptObject(updatedCreds, key) },
          });
          console.log(a.businessName, '| REFRESHED — new expiresAt:', expiresAt.toISOString());
        } catch (re) {
          console.log(a.businessName, '| REFRESH FAILED:', re.response?.status, JSON.stringify(re.response?.data || re.message));
        }
      } else {
        console.log(a.businessName, '| no refresh token — must reconnect');
      }
    }
  }
  await prisma.$disconnect();
})();
