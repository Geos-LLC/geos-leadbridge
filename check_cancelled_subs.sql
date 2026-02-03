-- Check all cancelled subscriptions with user details
SELECT
  u.id,
  u.email,
  u.name,
  u.subscriptionStatus,
  u.subscriptionTier,
  u.stripeSubscriptionId,
  u.subscriptionPeriodEnd,
  sh.eventType,
  sh.status,
  sh.createdAt as event_date
FROM users u
LEFT JOIN subscription_history sh ON sh.userId = u.id
WHERE
  u.subscriptionStatus = 'CANCELLED'
  OR sh.status = 'CANCELLED'
ORDER BY sh.createdAt DESC;

-- Check users with no active subscription (null stripeSubscriptionId)
SELECT
  id,
  email,
  name,
  subscriptionStatus,
  stripeSubscriptionId,
  subscriptionPeriodEnd
FROM users
WHERE stripeSubscriptionId IS NULL;

-- Get subscription history for a specific user
SELECT
  eventType,
  status,
  tier,
  stripeEventId,
  createdAt,
  metadata
FROM subscription_history
WHERE userId = 'USER_ID_HERE'
ORDER BY createdAt DESC;

-- Count cancellations by date
SELECT
  DATE(createdAt) as cancellation_date,
  COUNT(*) as cancellations
FROM subscription_history
WHERE status = 'CANCELLED'
GROUP BY DATE(createdAt)
ORDER BY cancellation_date DESC;
