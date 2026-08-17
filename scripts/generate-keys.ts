import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
const priv = Buffer.from(await exportPKCS8(privateKey)).toString("base64");
const pub = Buffer.from(await exportSPKI(publicKey)).toString("base64");
console.log(`JWT_PRIVATE_KEY_B64=${priv}`);
console.log(`JWT_PUBLIC_KEY_B64=${pub}`);
