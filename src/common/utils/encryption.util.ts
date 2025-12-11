/**
 * Encryption Utility
 * Used to encrypt/decrypt sensitive data like OAuth tokens
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

export class EncryptionUtil {
  /**
   * Encrypt a string value
   * @param text - Plain text to encrypt
   * @param secret - Encryption key (from environment variable)
   * @returns Encrypted string with IV and salt
   */
  static encrypt(text: string, secret: string): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    // Combine salt, iv, tag, and encrypted data
    return Buffer.concat([salt, iv, tag, Buffer.from(encrypted, 'hex')]).toString('base64');
  }

  /**
   * Decrypt an encrypted string
   * @param encryptedData - Encrypted string
   * @param secret - Encryption key (from environment variable)
   * @returns Decrypted plain text
   */
  static decrypt(encryptedData: string, secret: string): string {
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

  /**
   * Encrypt an object (converts to JSON first)
   */
  static encryptObject(obj: any, secret: string): string {
    return this.encrypt(JSON.stringify(obj), secret);
  }

  /**
   * Decrypt to an object (parses JSON after decryption)
   */
  static decryptObject<T>(encryptedData: string, secret: string): T {
    const decrypted = this.decrypt(encryptedData, secret);
    return JSON.parse(decrypted) as T;
  }

  /**
   * Generate a secure random string (for tokens, secrets, etc.)
   */
  static generateSecureRandom(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Hash a password using bcrypt-compatible method
   */
  static async hashPassword(password: string): Promise<string> {
    const bcrypt = require('bcryptjs');
    return bcrypt.hash(password, 10);
  }

  /**
   * Compare password with hash
   */
  static async comparePassword(password: string, hash: string): Promise<boolean> {
    const bcrypt = require('bcryptjs');
    return bcrypt.compare(password, hash);
  }
}
