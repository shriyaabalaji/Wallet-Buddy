// The firewall is the ONLY holder of the buyer key. The agent gets signatures, never the key,
// and only for EIP-712 TransferWithAuthorization messages that exactly match a payment the
// firewall already allowed and reserved. This is what makes the rules binding rather than advisory.
//
// Shape verified against @circle-fin/x402-batching@2.0.4 BatchEvmScheme.signAuthorization
// (dist/client/index.js): domain {name:"GatewayWalletBatched", version:"1", chainId, verifyingContract},
// primaryType "TransferWithAuthorization", message {from,to,value,validAfter,validBefore,nonce}.
import "./network";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";
import { immediate, type DB } from "./db";
import { resolveRecipient } from "./arc";

const buyerKey = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
const buyer = (() => {
  if (!buyerKey) return null;
  try {
    return privateKeyToAccount(buyerKey);
  } catch {
    console.error("BUYER_PRIVATE_KEY is invalid; signing disabled.");
    return null;
  }
})();
const GATEWAY_WALLETS = (process.env.GATEWAY_WALLET_ADDRESSES ?? "0x0077777d7EBA4688BDeF3E311b846F25870A19B9")
  .split(",")
  .filter(Boolean)
  .map((a) => getAddress(a.trim()));
const MAX_VALIDITY_S = 9 * 24 * 3600; // Gateway needs >= ~7 days; agent asks for 8

const AUTH_TYPES = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

export const signerAddress = () => buyer?.address ?? null;

export class SignError extends Error {}

export async function signForRequest(db: DB, requestId: string, td: any): Promise<Hex> {
  if (!buyer) throw new SignError("Firewall signer not configured (BUYER_PRIVATE_KEY).");
  const row = db.prepare("SELECT * FROM requests WHERE request_id=?").get(requestId) as any;
  if (!row) throw new SignError("Unknown request. Ask the firewall first.");
  if (row.status !== "reserved") throw new SignError(`Request is ${row.status}; only allowed payments can be signed.`);

  // --- domain ---
  const d = td?.domain ?? {};
  if (d.name !== "GatewayWalletBatched" || d.version !== "1") throw new SignError("Unsupported signing domain.");
  if (Number(d.chainId) !== config.arc.chainId) throw new SignError("Wrong chain.");
  if (!isAddress(d.verifyingContract ?? "") || !GATEWAY_WALLETS.includes(getAddress(d.verifyingContract))) throw new SignError("Unknown verifying contract.");
  // --- types ---
  if (td?.primaryType !== "TransferWithAuthorization") throw new SignError("Unsupported message type.");
  const t = td?.types?.TransferWithAuthorization;
  if (JSON.stringify(t) !== JSON.stringify(AUTH_TYPES)) throw new SignError("Unexpected message fields.");
  // --- message must match the reserved request exactly ---
  const m = td?.message ?? {};
  const expectedTo = resolveRecipient(row.recipient);
  if (!expectedTo) throw new SignError(`No address on file for ${row.recipient}.`);
  if (!isAddress(m.from ?? "") || getAddress(m.from) !== buyer.address) throw new SignError("Wrong payer.");
  if (!isAddress(m.to ?? "") || getAddress(m.to) !== getAddress(expectedTo)) throw new SignError("Payee doesn't match the approved recipient.");
  if (BigInt(m.value) !== BigInt(row.amount_micro)) throw new SignError("Amount doesn't match the approved amount.");
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(m.validBefore) > BigInt(now + MAX_VALIDITY_S)) throw new SignError("Authorization lasts too long.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(m.nonce ?? "")) throw new SignError("Bad nonce.");

  // One signature per allowed request, still reserved, for an agent that isn't paused (checked atomically with the claim).
  const claimed = immediate(db, () => db.prepare("UPDATE requests SET signed_ms=? WHERE request_id=? AND signed_ms IS NULL AND status='reserved' AND agent_id IN (SELECT id FROM agents WHERE status='active')").run(Date.now(), requestId).changes > 0);
  if (!claimed) throw new SignError("This payment was already signed, is no longer reserved, or its agent is paused.");

  return buyer.signTypedData({
    domain: { name: d.name, version: d.version, chainId: Number(d.chainId), verifyingContract: getAddress(d.verifyingContract) },
    types: { TransferWithAuthorization: AUTH_TYPES },
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(m.from),
      to: getAddress(m.to),
      value: BigInt(m.value),
      validAfter: BigInt(m.validAfter),
      validBefore: BigInt(m.validBefore),
      nonce: m.nonce as Hex,
    },
  });
}
