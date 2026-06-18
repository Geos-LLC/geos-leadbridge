/**
 * Pure-function tests for reclassifyCapture — the discriminator that
 * keeps the SystemErrorLog 'token_refresh' bucket clean of LB-side
 * failures that happen to surface inside a refresh code path.
 *
 * Motivation: 2026-06-16 Wesley Chapel incident. The proactive-refresh
 * cron caught a Prisma error ("column does not exist") and logged it
 * under category='token_refresh', telling the tenant to reconnect
 * Thumbtack — when the actual cause was an unapplied migration.
 */

import { reclassifyCapture } from './monitoring.service';

describe('reclassifyCapture — token_refresh hygiene', () => {
  describe('real OAuth rejections stay in token_refresh', () => {
    it('preserves a Thumbtack invalid_grant 400', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message:
          'thumbtack token refresh failed for business 549649303310548997 — ' +
          'Failed to refresh Thumbtack token: The provided authorization grant ' +
          '(e.g., authorization code, resource owner credentials) or refresh token ' +
          'is invalid, expired, revoked, does not match the redirection URI used in ' +
          'the authorization request, or was issued to another client. The refresh ' +
          'token is malformed or not valid. (status=400)',
      });
      expect(out).toEqual({ category: 'token_refresh', code: 'token_expired' });
    });

    it('preserves a Yelp token_expired', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'yelp token refresh failed for business abc — Token expired',
      });
      expect(out).toEqual({ category: 'token_refresh', code: 'token_expired' });
    });

    it('preserves unknown OAuth failures (best-effort default)', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — Some new TT error we have not seen',
      });
      expect(out).toEqual({ category: 'token_refresh', code: 'token_expired' });
    });
  });

  describe('Prisma errors redirect to other/db_error', () => {
    it('catches the Wesley Chapel "column does not exist" repro', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message:
          'thumbtack token refresh failed for business 581191492959928321 — ' +
          'Invalid `prisma.savedAccount.update()` invocation:\n' +
          'The column `saved_accounts.serviceProfileAssignmentsJson` does not exist in the current database.',
      });
      expect(out).toEqual({ category: 'other', code: 'db_error' });
    });

    it('catches Unknown argument from Prisma', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — Unknown argument `companyName`.',
      });
      expect(out).toEqual({ category: 'other', code: 'db_error' });
    });

    it('catches Unknown field from Prisma select', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — Unknown field `legacyColumn` for select statement on model `SavedAccount`.',
      });
      expect(out).toEqual({ category: 'other', code: 'db_error' });
    });

    it('catches foreign key constraint failures', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — Foreign key constraint failed on the field: `userId`',
      });
      expect(out).toEqual({ category: 'other', code: 'db_error' });
    });
  });

  describe('Crypto / decrypt errors redirect to other/crypto_error', () => {
    it('catches EncryptionUtil failures', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — EncryptionUtil.decryptObject: bad decrypt',
      });
      expect(out).toEqual({ category: 'other', code: 'crypto_error' });
    });

    it('catches "Failed to decrypt"', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — Failed to decrypt credentials',
      });
      expect(out).toEqual({ category: 'other', code: 'crypto_error' });
    });
  });

  describe('Network errors redirect to other/network_error', () => {
    it('catches ECONNREFUSED', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — connect ECONNREFUSED 1.2.3.4:443',
      });
      expect(out).toEqual({ category: 'other', code: 'network_error' });
    });

    it('catches socket hang up', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'thumbtack token refresh failed — socket hang up',
      });
      expect(out).toEqual({ category: 'other', code: 'network_error' });
    });
  });

  describe('Non-token_refresh inputs pass through untouched', () => {
    it('does not touch automation category', () => {
      const out = reclassifyCapture({
        category: 'automation',
        code: 'automation_failure',
        message: 'Invalid `prisma.automationRule.update()` invocation: column does not exist',
      });
      expect(out).toEqual({ category: 'automation', code: 'automation_failure' });
    });

    it('does not touch webhook category', () => {
      const out = reclassifyCapture({
        category: 'webhook',
        code: 'webhook_missing',
        message: 'EncryptionUtil failed',
      });
      expect(out).toEqual({ category: 'webhook', code: 'webhook_missing' });
    });

    it('does not touch other category', () => {
      const out = reclassifyCapture({
        category: 'other',
        code: 'foo',
        message: 'Prisma error',
      });
      expect(out).toEqual({ category: 'other', code: 'foo' });
    });
  });

  describe('Edge cases', () => {
    it('handles undefined message', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: undefined as any,
      });
      expect(out).toEqual({ category: 'token_refresh', code: 'token_expired' });
    });

    it('handles empty message', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: '',
      });
      expect(out).toEqual({ category: 'token_refresh', code: 'token_expired' });
    });

    it('matches case-insensitively (Prisma in TitleCase)', () => {
      const out = reclassifyCapture({
        category: 'token_refresh',
        code: 'token_expired',
        message: 'Prisma error somewhere',
      });
      expect(out).toEqual({ category: 'other', code: 'db_error' });
    });
  });
});
