/**
 * Per-platform fetchers that turn a connected SavedAccount into a
 * Partial<businessInformation> patch ready for the merger.
 *
 * Each fetcher is best-effort: any failure (no creds, expired token,
 * shape mismatch, network) returns undefined and we log a warning. The
 * caller's merge step then no-ops for that source.
 *
 * What each platform can give us (per the scope doc):
 *
 *   Thumbtack — limited. Partner API surfaces business name + category +
 *               minimal location at most. Pricing/quote history is
 *               explicitly out of scope for this round.
 *   Yelp Fusion — richer. GET /v3/businesses/:id returns name, address,
 *               phones, hours, categories, attributes (sometimes payment
 *               methods), photos. We do NOT use the `price` `$/$$/$$$`
 *               tier as pricing guidance.
 */

import axios from 'axios';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformService } from '../platforms/platform.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { PlatformName } from '../common/interfaces/platform.interface';
import type { PlaybookSeed } from './users.service';

type BizInfo = NonNullable<PlaybookSeed['businessInformation']>;

const logger = new Logger('BusinessInfoSources');

/**
 * Pull whatever Thumbtack will give us for the connected business.
 *
 * Thumbtack's Partner API exposes /v4/businesses (the listing we already
 * fetch in OAuth callback for saveAccount). That response carries:
 *   - businessID, name, imageURL  (confirmed live)
 *   - categories?, address?       (sometimes — depends on the pro's profile)
 *
 * We only project fields we're confident about. Anything missing falls
 * through to undefined and gets ignored by the merger.
 */
export async function fetchThumbtackBusinessInfo(args: {
  userId: string;
  savedAccountId: string;
  platformService: PlatformService;
  platformFactory: PlatformFactory;
  prisma: PrismaService;
}): Promise<Partial<BizInfo> | undefined> {
  try {
    const account = await args.prisma.savedAccount.findFirst({
      where: { id: args.savedAccountId, userId: args.userId, platform: PlatformName.THUMBTACK },
      select: { businessId: true, businessName: true },
    });
    if (!account?.businessId) {
      logger.warn(`[fetchThumbtackBusinessInfo] account not found or no businessId: ${args.savedAccountId}`);
      return undefined;
    }

    // Reuse the /businesses listing — cached creds + refresh-on-401 are
    // handled inside platformService.getCredentials. The listing is per
    // user/token, not per-business — we look up our specific business by
    // id afterwards.
    const creds = await args.platformService.getCredentials(args.userId, PlatformName.THUMBTACK);
    const adapter = args.platformFactory.getAdapter(PlatformName.THUMBTACK) as any;
    if (typeof adapter.getBusinesses !== 'function') return undefined;
    const businesses = await adapter.getBusinesses(creds);
    const match = (businesses || []).find((b: any) => b.businessID === account.businessId);
    if (!match) {
      logger.warn(`[fetchThumbtackBusinessInfo] business ${account.businessId} not in /businesses listing`);
      return undefined;
    }

    const out: Partial<BizInfo> = {};

    // Location — most TT pros set their service area as a city+state at
    // minimum. The Partner API returns this nested under `address` /
    // `serviceAreas` depending on profile completeness; we coalesce.
    const addressBits: string[] = [];
    const a = match.address || match.location || {};
    if (a.city)  addressBits.push(a.city);
    if (a.state) addressBits.push(a.state);
    if (a.zipCode || a.zip) addressBits.push(a.zipCode || a.zip);
    const addressLine = addressBits.join(', ');
    if (addressLine) {
      out.serviceArea = addressLine;
      out.officeLocations = [addressLine];
    }

    // Owner / display phone — these come back inconsistently. Only set
    // when present so we don't shadow a future website value with an
    // empty string.
    if (typeof match.phoneNumber === 'string' && match.phoneNumber.trim()) {
      // Phones live in humanHandoffGuidance, not in businessInformation —
      // but since businessInformation tracks the canonical contact phone
      // for the AI's reference block, we don't write phone into bizInfo
      // here. The handoff merger handles that separately.
    }

    return Object.keys(out).length === 0 ? undefined : out;
  } catch (err: any) {
    logger.warn(`[fetchThumbtackBusinessInfo] failed: ${err?.message || err}`);
    return undefined;
  }
}

/**
 * Pull from Yelp Fusion `/v3/businesses/:id`. Yelp gives us the richest
 * structured data of any source: address, phones, categories, hours,
 * sometimes payment-method attributes.
 *
 * Token refresh is handled by reading credentials via PlatformService,
 * which transparently refreshes on 401.
 */
export async function fetchYelpBusinessInfo(args: {
  userId: string;
  savedAccountId: string;
  platformService: PlatformService;
  prisma: PrismaService;
}): Promise<Partial<BizInfo> | undefined> {
  try {
    const account = await args.prisma.savedAccount.findFirst({
      where: { id: args.savedAccountId, userId: args.userId, platform: PlatformName.YELP },
      select: { businessId: true },
    });
    if (!account?.businessId) {
      logger.warn(`[fetchYelpBusinessInfo] account not found or no businessId: ${args.savedAccountId}`);
      return undefined;
    }

    const creds = await args.platformService.getAccountCredentials(args.userId, args.savedAccountId);
    if (!creds?.accessToken) {
      logger.warn(`[fetchYelpBusinessInfo] no access token for account ${args.savedAccountId}`);
      return undefined;
    }

    const url = `https://api.yelp.com/v3/businesses/${encodeURIComponent(account.businessId)}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      timeout: 15000,
    });
    const b: any = response.data || {};

    const out: Partial<BizInfo> = {};

    // Service area — Yelp gives city+state+zip in one location object.
    const loc = b.location || {};
    const cityState = [loc.city, loc.state, loc.zip_code].filter(Boolean).join(', ');
    if (cityState) out.serviceArea = cityState;

    // Full display address → officeLocations.
    if (Array.isArray(loc.display_address) && loc.display_address.length > 0) {
      out.officeLocations = [loc.display_address.join(', ')];
    }

    // Payment methods from Yelp's free-form `attributes` block. The shape
    // varies wildly per business type — we hunt for the common keys.
    const attrs = b.attributes || {};
    const methods: string[] = [];
    const checkBool = (k: string, label: string) => {
      if (attrs[k] === true) methods.push(label);
    };
    checkBool('business_accepts_credit_cards', 'card');
    checkBool('accepts_cash', 'cash');
    checkBool('business_accepts_apple_pay', 'apple_pay');
    checkBool('business_accepts_google_pay', 'google_pay');
    if (methods.length > 0) out.paymentMethods = methods;

    // Yelp's review_count / rating are kept in the website summary
    // (objectionHandling.trustSignals) when present on the site itself,
    // not here — businessInformation is for facts about the business,
    // not for social proof. Skipping.

    return Object.keys(out).length === 0 ? undefined : out;
  } catch (err: any) {
    const status = err?.response?.status;
    logger.warn(`[fetchYelpBusinessInfo] failed (status=${status}): ${err?.message || err}`);
    return undefined;
  }
}
