import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 60 * 60 * 8; // 8hrs

function getKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set (at least 32 characters)");
  }
  return new TextEncoder().encode(secret);
}

/**
 * `version` is the user's `sessionVersion` at sign-in time. Changing or resetting the
 * password bumps that column, so tokens issued before the change stop working.
 */
export async function signSessionToken(userId: string, version: number) {
  return new SignJWT({ ver: version })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getKey());
}

export async function verifySessionToken(token: string) {
  const key = getKey();
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      // Tokens issued before token versioning have no `ver` claim and must not match.
      version: typeof payload.ver === "number" ? payload.ver : -1,
    };
  } catch {
    return null;
  }
}
