import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

type SupportedAlgorithm = 'aes-256-gcm';

export type EncryptedFieldEnvelope = {
  __enc: true;
  alg: SupportedAlgorithm;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
};

@Injectable()
export class PhiCryptoService {
  private readonly algorithm: SupportedAlgorithm = 'aes-256-gcm';
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;
  private readonly keyId: string;

  constructor(private readonly configService: ConfigService) {
    this.encryptionKey = this.readKey('PHI_ENCRYPTION_KEY_B64');
    this.indexKey = this.readKey('PHI_INDEX_KEY_B64');
    this.keyId = this.configService.get<string>('PHI_ENCRYPTION_KEY_ID', 'v1');
  }

  isEncryptedValue(value: unknown): value is EncryptedFieldEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const encryptedValue = value as Partial<EncryptedFieldEnvelope>;
    return (
      encryptedValue.__enc === true &&
      encryptedValue.alg === this.algorithm &&
      typeof encryptedValue.kid === 'string' &&
      typeof encryptedValue.iv === 'string' &&
      typeof encryptedValue.tag === 'string' &&
      typeof encryptedValue.ct === 'string'
    );
  }

  encryptValue(value: unknown) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || this.isEncryptedValue(value)) {
      return value;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);
    const serialized = JSON.stringify(value);
    const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      __enc: true,
      alg: this.algorithm,
      kid: this.keyId,
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      ct: ciphertext.toString('base64'),
    } satisfies EncryptedFieldEnvelope;
  }

  decryptValue<T = unknown>(value: T): T {
    if (!this.isEncryptedValue(value)) {
      return value;
    }

    try {
      const decipher = createDecipheriv(
        value.alg,
        this.encryptionKey,
        Buffer.from(value.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(value.ct, 'base64')),
        decipher.final(),
      ]);

      return JSON.parse(decrypted.toString('utf8')) as T;
    } catch (error) {
      throw new InternalServerErrorException('Failed to decrypt protected data.');
    }
  }

  buildBlindIndex(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    return createHmac('sha256', this.indexKey)
      .update(JSON.stringify(value))
      .digest('hex');
  }

  private readKey(envName: string) {
    const configuredValue = this.configService.get<string>(envName);
    if (!configuredValue) {
      throw new Error(`${envName} must be configured for PHI encryption.`);
    }

    const decoded = Buffer.from(configuredValue, 'base64');
    if (decoded.length !== 32) {
      throw new Error(`${envName} must decode to exactly 32 bytes.`);
    }

    return decoded;
  }
}
