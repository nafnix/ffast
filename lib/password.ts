import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";

const COST = 1 << 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  });

  return ["scrypt", COST, BLOCK_SIZE, PARALLELISM, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, costText, blockSizeText, parallelismText, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !costText || !blockSizeText || !parallelismText || !saltText || !keyText) {
    return false;
  }

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelism = Number(parallelismText);
  if (!Number.isInteger(cost) || cost < 2 || cost > 1 << 18 || !Number.isInteger(blockSize) || blockSize < 1 || blockSize > 32) {
    return false;
  }
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 8) return false;

  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;

  const actual = await deriveKey(password, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: MAX_MEMORY,
  });

  return timingSafeEqual(actual, expected);
}
