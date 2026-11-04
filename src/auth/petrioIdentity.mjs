import { createSignedIdentityAuth } from "./signedIdentity.mjs";

export function createPetrioIdentityAuth(options = {}) {
  return createSignedIdentityAuth({
    secret: process.env.ALFIE_CORE_PETRIO_IDENTITY_SECRET || process.env.ALFIE_CORE_IDENTITY_SECRET || "",
    ...options,
    providerId: "petrio",
    providerHeader: null,
    headerNames: {
      userId: "x-petrio-user-id",
      timestamp: "x-petrio-auth-timestamp",
      nonce: "x-petrio-auth-nonce",
      method: "x-petrio-auth-method",
      path: "x-petrio-auth-path",
      signature: "x-petrio-auth-signature"
    }
  });
}
