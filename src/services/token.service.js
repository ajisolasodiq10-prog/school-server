import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

// Verifies access tokens issued by the Account Management Backend. This backend holds only the
// PUBLIC key (ACCOUNT_TOKEN_PUBLIC_KEY), so it can check a token but can never create one.
// Only asymmetric algorithms are accepted (config refuses HS* and "none"), which also rules out
// the "sign it with the public key as an HMAC secret" downgrade attack.
//
// The token proves WHO the account is (`sub` = account id). Role and school are never read from
// it: authenticate() takes them from this backend's own user record.
export function verifyAccountToken(token) {
  const { publicKey, algorithms, issuer, audience, clockToleranceSeconds } = config.accountToken;
  return jwt.verify(token, publicKey, {
    algorithms,
    issuer,
    audience,
    clockTolerance: clockToleranceSeconds,
  });
}
