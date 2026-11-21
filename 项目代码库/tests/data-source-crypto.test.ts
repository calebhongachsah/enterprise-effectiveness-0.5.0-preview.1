import assert from "node:assert/strict";
import test from "node:test";
import {
  dataSourceMasterKey,
  decryptDataSourceSecret,
  encryptDataSourceSecret,
} from "../apps/api/src/data-source-crypto.js";

test("数据源凭据可以加密并解密，且密文不包含明文", () => {
  const key = Buffer.alloc(32, 7);
  const password = "customer-db-password";
  const encrypted = encryptDataSourceSecret(password, key);
  assert.notEqual(encrypted.encryptedValue.toString("utf8"), password);
  assert.equal(decryptDataSourceSecret(encrypted, key), password);
});

test("同一凭据每次加密产生不同密文", () => {
  const key = Buffer.alloc(32, 9);
  const first = encryptDataSourceSecret("same-password", key);
  const second = encryptDataSourceSecret("same-password", key);
  assert.notDeepEqual(first.initializationVector, second.initializationVector);
  assert.notDeepEqual(first.encryptedValue, second.encryptedValue);
});

test("错误密钥无法解密凭据", () => {
  const encrypted = encryptDataSourceSecret("secret", Buffer.alloc(32, 1));
  assert.throws(() => decryptDataSourceSecret(encrypted, Buffer.alloc(32, 2)));
});

test("环境密钥必须是 32 字节 Base64", () => {
  assert.throws(() => dataSourceMasterKey("c2hvcnQ="), /32 字节/);
  assert.equal(
    dataSourceMasterKey(Buffer.alloc(32, 3).toString("base64")).length,
    32,
  );
});
