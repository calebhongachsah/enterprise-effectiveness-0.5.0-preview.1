import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type EncryptedSecret = {
  encryptedValue: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
  keyVersion: number;
};

export function dataSourceMasterKey(
  encoded = process.env.DATA_SOURCE_MASTER_KEY,
) {
  if (!encoded) {
    throw new Error("缺少 DATA_SOURCE_MASTER_KEY，无法保存数据源凭据");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("DATA_SOURCE_MASTER_KEY 必须是 32 字节密钥的 Base64 编码");
  }
  return key;
}

export function encryptDataSourceSecret(
  plaintext: string,
  key = dataSourceMasterKey(),
  keyVersion = 1,
): EncryptedSecret {
  if (!plaintext) throw new Error("数据源凭据不能为空");
  if (key.length !== KEY_BYTES) throw new Error("数据源主密钥长度无效");
  const initializationVector = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, initializationVector);
  const encryptedValue = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    encryptedValue,
    initializationVector,
    authenticationTag: cipher.getAuthTag(),
    keyVersion,
  };
}

export function decryptDataSourceSecret(
  secret: EncryptedSecret,
  key = dataSourceMasterKey(),
) {
  if (key.length !== KEY_BYTES) throw new Error("数据源主密钥长度无效");
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    secret.initializationVector,
  );
  decipher.setAuthTag(secret.authenticationTag);
  return Buffer.concat([
    decipher.update(secret.encryptedValue),
    decipher.final(),
  ]).toString("utf8");
}
