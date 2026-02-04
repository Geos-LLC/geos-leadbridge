-- Check if cancelAtPeriodEnd is set for your subscription
SELECT 
  email,
  subscriptionStatus,
  subscriptionTier,
  subscriptionPeriodEnd,
  cancelAtPeriodEnd,
  stripeSubscriptionId
FROM "User"
WHERE subscriptionStatus = 'ACTIVE'
  AND subscriptionTier IS NOT NULL;
