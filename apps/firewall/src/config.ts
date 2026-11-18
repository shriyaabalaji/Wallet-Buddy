import "./network";
const env = (k: string) => {
  const v = process.env[k];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

export const config = {
  port: Number(env("FIREWALL_PORT") ?? 4000),
  dbPath: env("FIREWALL_DB") ?? "./firewall.db",
  appBaseUrl: env("APP_BASE_URL") ?? "http://localhost:3000",
  /** Public URL Twilio posts to; must match exactly for signature validation. */
  publicUrl: env("FIREWALL_PUBLIC_URL") ?? `http://localhost:${env("FIREWALL_PORT") ?? 4000}`,
  devMode: process.env.NODE_ENV !== "production",
  holdMinutes: Number(env("HOLD_MINUTES") ?? 15),
  /** An allowed payment never signed or paid within this long gives its budget back (engine.releaseStaleReservations). */
  reservationTtlMinutes: Math.max(5, Number(env("RESERVATION_TTL_MINUTES") ?? 15) || 15),
  /** Sellers accept any payment header (local demo): settlements are recorded as simulated. */
  mockPayments: env("MOCK_PAYMENTS") === "1",
  arc: {
    rpcUrl: env("ARC_RPC_URL") ?? "https://rpc.testnet.arc.io",
    chainId: Number(env("ARC_CHAIN_ID") ?? 5042002),
    explorerUrl: env("ARC_EXPLORER_URL") ?? "https://explorer.testnet.arc.io",
    servicePrivateKey: env("SERVICE_PRIVATE_KEY") as `0x${string}` | undefined,
    /** Hackathon shortcut: the owner key is held by the service and used only after a passkey check. */
    ownerPrivateKey: env("OWNER_PRIVATE_KEY") as `0x${string}` | undefined,
    registryAddress: env("REGISTRY_ADDRESS") as `0x${string}` | undefined,
    vaultAddress: env("VAULT_ADDRESS") as `0x${string}` | undefined,
  },
  twilio: {
    accountSid: env("TWILIO_ACCOUNT_SID"),
    authToken: env("TWILIO_AUTH_TOKEN"),
    from: env("TWILIO_FROM"),
    ownerPhone: env("OWNER_PHONE"),
  },
  llmApiKey: env("LLM_API_KEY") ?? env("ANTHROPIC_API_KEY"),
  webauthn: {
    rpId: env("WEBAUTHN_RP_ID") ?? new URL(env("APP_BASE_URL") ?? "http://localhost:3000").hostname,
    origin: env("APP_BASE_URL") ?? "http://localhost:3000",
  },
};

export const explorerTx = (hash: string | null | undefined) => (hash ? `${config.arc.explorerUrl}/tx/${hash}` : null);
