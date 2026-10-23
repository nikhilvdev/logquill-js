import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = 0x80;

// Fernet tokens and keys are url-safe base64 *with* padding; Node's "base64url" omits it.
function toFernetBase64(bytes: Buffer): string {
  const encoded = bytes.toString("base64url");
  return encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
}

/** Splits a Fernet key into its 16-byte signing key and 16-byte AES key, or throws an actionable error. */
function splitKey(key: string): { signing: Buffer; encryption: Buffer } {
  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 32) {
    throw new Error(
      "Fernet key must be 32 url-safe base64-encoded bytes — generate one with generateFernetKey() " +
        "(or Python's `cryptography.fernet.Fernet.generate_key()`)",
    );
  }
  return { signing: raw.subarray(0, 16), encryption: raw.subarray(16) };
}

/** A fresh random key for {@link fernetEncrypt}, in the same format Python's `Fernet.generate_key()` produces. */
export function generateFernetKey(): string {
  return toFernetBase64(randomBytes(32));
}

/**
 * Encrypts `plaintext` as a Fernet token (AES-128-CBC + HMAC-SHA256), the
 * format `logquill-python`'s `FileTransport(encrypt_key=...)` writes, so a
 * file encrypted by either package can be decrypted by the other.
 */
export function fernetEncrypt(key: string, plaintext: string): string {
  const { signing, encryption } = splitKey(key);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", encryption, iv);
  const body = Buffer.concat([
    Buffer.from([VERSION]),
    timestamp,
    iv,
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const mac = createHmac("sha256", signing).update(body).digest();
  return toFernetBase64(Buffer.concat([body, mac]));
}

/** Decrypts a token produced by {@link fernetEncrypt} or Python's `Fernet.encrypt()`. Throws if the key is wrong or the token was altered. */
export function fernetDecrypt(key: string, token: string): string {
  const { signing, encryption } = splitKey(key);
  const data = Buffer.from(token.trim(), "base64url");
  if (data.length < 9 + 16 + 32 || data[0] !== VERSION) {
    throw new Error("Not a Fernet token — was this line written with encryptKey?");
  }
  const body = data.subarray(0, data.length - 32);
  const expected = createHmac("sha256", signing).update(body).digest();
  if (!timingSafeEqual(expected, data.subarray(data.length - 32))) {
    throw new Error("Fernet token failed verification — wrong key, or the line was edited");
  }
  const decipher = createDecipheriv("aes-128-cbc", encryption, body.subarray(9, 25));
  return Buffer.concat([decipher.update(body.subarray(25)), decipher.final()]).toString("utf8");
}
