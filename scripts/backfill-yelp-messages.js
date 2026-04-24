/**
 * One-time backfill: populate Message table with historical Yelp conversation
 * events for existing Yelp leads. After this runs, getMessages serves DB-first
 * for those leads instead of hitting the live Yelp API.
 *
 * Standalone script — uses PrismaClient directly, inlined credential decryption,
 * axios for Yelp API. No Nest bootstrap (keeps startup fast).
 *
 * Usage:
 *   node scripts/backfill-yelp-messages.js --userId=<uuid> [--businessId=<id>] [--limit=5] [--dryRun=true]
 *
 * Required env (exported from AWS Secrets Manager):
 *   DATABASE_URL
 *   DIRECT_URL
 *   ENCRYPTION_KEY
 *   YELP_CLIENT_ID
 *   YELP_CLIENT_SECRET
 *
 * Safety:
 *   - Writes ONLY to the Message table. Never mutates leads/status/sends SMS.
 *   - Dedups on `(platform, externalMessageId)` unique constraint.
 *   - Re-running is idempotent (all re-insertions are skipped as duplicates).
 *   - Defaults to --dryRun=true; pass --dryRun=false to actually write.
 */

// Load .env first so local runs pick up YELP_CLIENT_ID etc. without manual exports.
// AWS Secrets Manager's leadbridge-prod-secrets has some keys empty (Yelp creds); Railway env
// is the source of truth at runtime. For ad-hoc script runs we merge both:
//   1. .env (has Yelp creds)
//   2. AWS Secrets Manager overrides (has current rotated DATABASE_URL / ENCRYPTION_KEY)
require('dotenv').config();

const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');
const axios = require('axios');

// Overlay AWS Secrets Manager onto env (keys with non-empty values win over .env).
// Done synchronously before PrismaClient imports so DATABASE_URL is current.
try {
  const raw = execSync(
    'aws secretsmanager get-secret-value --secret-id leadbridge-prod-secrets --region us-east-1 --query SecretString --output text',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const cleaned = raw.replace(/^﻿/, '').trim();
  const secrets = JSON.parse(cleaned);
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === 'string' && v.length > 0) process.env[k] = v;
  }
  console.log('[env] Overlaid ' + Object.keys(secrets).filter((k) => secrets[k]).length + ' keys from AWS Secrets Manager');
} catch (e) {
  console.warn('[env] AWS Secrets Manager overlay failed (' + e.message + ') — proceeding with .env only');
}

const { PrismaClient } = require('../generated/prisma');

// ─── Crypto (mirrors src/common/utils/encryption.util.ts) ──────────────
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

function decryptObject(encryptedData, secret) {
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
  return JSON.parse(decrypted);
}

// ─── Yelp API ──────────────────────────────────────────────────────────
const YELP_BASE = 'https://api.yelp.com/v3';

async function yelpGetEvents(accessToken, leadId) {
  const res = await axios.get(`${YELP_BASE}/leads/${leadId}/events`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return res.data?.events || res.data?.data || [];
}

async function yelpRefreshToken(refreshToken, clientId, clientSecret) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await axios.post('https://api.yelp.com/oauth2/token', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token || refreshToken,
    expiresAt: res.data.expires_in ? new Date(Date.now() + res.data.expires_in * 1000) : undefined,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { limit: 5, dryRun: true };
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'userId') out.userId = m[2];
    else if (m[1] === 'businessId') out.businessId = m[2];
    else if (m[1] === 'limit') out.limit = parseInt(m[2], 10);
    else if (m[1] === 'dryRun') out.dryRun = m[2] === 'true' || m[2] === '1';
  }
  return out;
}

// ─── Normalize Yelp event → Message insertion payload ──────────────────
function normalizeEvent(event, lead) {
  if (!lead.threadId) return null; // no Conversation row to attach to
  if (event.event_type !== 'TEXT') return null; // skip RAQ_SUBMIT / opt-in / etc.

  const content =
    typeof event.event_content === 'string'
      ? event.event_content
      : event.event_content?.text || event.event_content?.fallback_text || event.text || '';
  if (!content) return null;

  const sender = event.user_type === 'CONSUMER' ? 'customer' : 'pro';
  const sentAt = event.time_created ? new Date(event.time_created) : new Date();
  const externalMessageId = event.id
    ? String(event.id)
    : `yelp-synth-${lead.externalRequestId}-${sentAt.toISOString()}-${sender}-${content.length}`;

  return {
    conversationId: lead.threadId,
    userId: lead.userId,
    platform: 'yelp',
    externalMessageId,
    sender,
    senderType: null, // historical — we don't know if pro messages were AI vs manual
    content,
    isRead: sender === 'pro',
    sentAt,
    rawJson: JSON.stringify(event).slice(0, 8000),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId) {
    console.error('✗ --userId=<uuid> is required');
    process.exit(1);
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    console.error('✗ --limit must be a positive integer');
    process.exit(1);
  }
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const yelpClientId = process.env.YELP_CLIENT_ID;
  const yelpClientSecret = process.env.YELP_CLIENT_SECRET;
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY env required');
  if (!yelpClientId || !yelpClientSecret) throw new Error('YELP_CLIENT_ID + YELP_CLIENT_SECRET env required');

  console.log('=== Backfill Yelp messages ===');
  console.log('userId:     ' + args.userId);
  console.log('businessId: ' + (args.businessId || '(all)'));
  console.log('limit:      ' + args.limit);
  console.log('dryRun:     ' + args.dryRun);
  console.log('');

  const prisma = new PrismaClient();

  try {
    // Cache decrypted creds per savedAccount to avoid redundant decryption across leads
    // and to persist refreshed tokens for subsequent leads in the same run.
    const credsByAccountId = new Map();

    const leads = await prisma.lead.findMany({
      where: {
        userId: args.userId,
        platform: 'yelp',
        ...(args.businessId && { businessId: args.businessId }),
        threadId: { not: null },
        businessId: { not: null },
      },
      take: args.limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        customerName: true,
        businessId: true,
        externalRequestId: true,
        threadId: true,
      },
    });

    console.log(`Found ${leads.length} Yelp leads (threadId + businessId not null).\n`);

    let totalFetched = 0;
    let totalInserted = 0;
    let totalSkippedDup = 0;
    let totalSkippedNoContent = 0;
    let totalFailed = 0;
    const failures = [];

    for (const lead of leads) {
      const t0 = Date.now();
      const stats = { fetched: 0, inserted: 0, skippedDup: 0, skippedNoContent: 0 };

      try {
        // Find Yelp SavedAccount + creds (cached after first lookup per account)
        const account = await prisma.savedAccount.findFirst({
          where: { userId: lead.userId, platform: 'yelp', businessId: lead.businessId },
          select: { id: true, credentialsJson: true },
        });
        if (!account?.credentialsJson) throw new Error('no creds row for business ' + lead.businessId);

        let creds = credsByAccountId.get(account.id);
        if (!creds) {
          creds = decryptObject(account.credentialsJson, encryptionKey);
          credsByAccountId.set(account.id, creds);
        }
        if (!creds.accessToken) throw new Error('decrypted creds missing accessToken');

        // Fetch events (retry once with refreshed token on 401)
        let events;
        try {
          events = await yelpGetEvents(creds.accessToken, lead.externalRequestId);
        } catch (err) {
          const status = err.response?.status;
          if (status === 401 && creds.refreshToken) {
            console.log(`    token 401, refreshing…`);
            const refreshed = await yelpRefreshToken(creds.refreshToken, yelpClientId, yelpClientSecret);
            creds = { ...creds, ...refreshed };
            credsByAccountId.set(account.id, creds);
            events = await yelpGetEvents(creds.accessToken, lead.externalRequestId);
          } else {
            throw err;
          }
        }

        stats.fetched = events.length;

        for (const event of events) {
          const normalized = normalizeEvent(event, lead);
          if (!normalized) {
            stats.skippedNoContent++;
            continue;
          }

          if (args.dryRun) {
            const existing = await prisma.message.findUnique({
              where: { platform_externalMessageId: { platform: 'yelp', externalMessageId: normalized.externalMessageId } },
              select: { id: true },
            });
            if (existing) stats.skippedDup++;
            else stats.inserted++;
            continue;
          }

          try {
            await prisma.message.create({ data: normalized });
            stats.inserted++;
          } catch (err) {
            if (err.code === 'P2002') {
              stats.skippedDup++;
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        totalFailed++;
        failures.push({
          leadId: lead.id,
          customerName: lead.customerName,
          error: err.message || String(err),
        });
        const dur = Date.now() - t0;
        console.log(`  ✗ ${lead.id.slice(0, 8)} "${lead.customerName}" — FAILED: ${err.message} (${dur}ms)`);
        continue;
      }

      totalFetched += stats.fetched;
      totalInserted += stats.inserted;
      totalSkippedDup += stats.skippedDup;
      totalSkippedNoContent += stats.skippedNoContent;

      const dur = Date.now() - t0;
      const action = args.dryRun ? 'would-insert' : 'inserted';
      console.log(
        `  ✓ ${lead.id.slice(0, 8)} "${lead.customerName}" — fetched=${stats.fetched} ${action}=${stats.inserted} dup=${stats.skippedDup} no-content=${stats.skippedNoContent} (${dur}ms)`,
      );
    }

    console.log('');
    console.log('=== Summary ===');
    console.log(`Leads scanned:        ${leads.length}`);
    console.log(`Messages fetched:     ${totalFetched}`);
    console.log(`Messages ${args.dryRun ? 'would-insert' : 'inserted'}:  ${totalInserted}`);
    console.log(`Skipped (duplicate):  ${totalSkippedDup}`);
    console.log(`Skipped (no content): ${totalSkippedNoContent}`);
    console.log(`Failed leads:         ${totalFailed}`);
    console.log(`Dry run:              ${args.dryRun}`);

    if (failures.length > 0) {
      console.log('\n=== Failures ===');
      failures.forEach((f) => console.log(`  ${f.leadId.slice(0, 8)} ${f.customerName}: ${f.error}`));
    }

    if (args.dryRun) {
      console.log('\n(Dry run — no DB writes. Re-run with --dryRun=false to apply.)');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
