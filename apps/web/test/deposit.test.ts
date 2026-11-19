// MetaMask deposit helpers: amount parsing, calldata, and the approve → depositFor flow against a fake EIP-1193 wallet.
import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, parseAbi, toFunctionSelector } from "viem";
import {
  addChainParams, approveData, deposit, depositForData, parseUsdcAmount, walletError,
  type DepositStep, type DepositTarget, type Eip1193,
} from "../src/lib/deposit";

const T: DepositTarget = {
  enabled: true, network: "testnet", chainId: 5042002, chainName: "Arc Testnet", rpcUrls: ["https://rpc.testnet.arc.io"],
  explorerUrl: "https://explorer.testnet.arc.io", usdc: "0x3600000000000000000000000000000000000000",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9", depositor: getAddress("0x74f1e850fc6c03546e59e6aef7db41ff9f0e318b"),
  paymentMode: "circle-agent-wallet",
};
const ME = getAddress("0x1111111111111111111111111111111111111111");

describe("parseUsdcAmount", () => {
  it.each([["5", 5_000_000n], ["2.5", 2_500_000n], ["$0.01", 10_000n], [".5", 500_000n], ["3.", 3_000_000n], ["1.123456", 1_123_456n]])("%s", (s, micro) => {
    expect(parseUsdcAmount(s)).toEqual({ ok: true, micro });
  });
  it.each(["", "abc", "-1", "1e3", "1,000", "0", "0.009", "1.1234567", "0x10"])("rejects %j", (s) => {
    expect(parseUsdcAmount(s).ok).toBe(false);
  });
});

describe("calldata", () => {
  it("depositFor(token, depositor, value) in Circle's argument order", () => {
    const data = depositForData(T.usdc, T.depositor, 5_000_000n);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("depositFor(address,address,uint256)"));
    const d = decodeFunctionData({ abi: parseAbi(["function depositFor(address token, address depositor, uint256 value)"]), data });
    expect(d.args).toEqual([getAddress(T.usdc), T.depositor, 5_000_000n]);
  });
  it("approve(spender = GatewayWallet, exact amount)", () => {
    const d = decodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount)"]), data: approveData(T.gatewayWallet, 7n) });
    expect(d.args).toEqual([getAddress(T.gatewayWallet), 7n]);
  });
  it("adds Arc with USDC as the gas token", () => {
    expect(addChainParams(T)).toMatchObject({ chainId: "0x4cef52", nativeCurrency: { symbol: "USDC", decimals: 18 }, blockExplorerUrls: [T.explorerUrl] });
  });
});

/** A fake MetaMask: answers reads from state, records sent transactions, mines them immediately. */
function fakeWallet(o: { balance: bigint; allowance: bigint; chainId?: number; account?: string; failApprove?: boolean; switchChainAfterApprove?: number; unauthorizedSends?: number }) {
  const sent: { to: string; data: string; gas?: string }[] = [];
  const calls: string[] = [];
  let unauthorized = o.unauthorizedSends ?? 0;
  let chain = o.chainId ?? T.chainId;
  const p: Eip1193 = {
    async request({ method, params }) {
      const arg = (params?.[0] ?? {}) as any;
      calls.push(method);
      switch (method) {
        case "wallet_requestPermissions": return [{ parentCapability: "eth_accounts" }];
        case "wallet_switchEthereumChain": chain = Number(BigInt(arg.chainId)); return null;
        case "eth_chainId": return `0x${chain.toString(16)}`;
        case "eth_accounts": return [o.account ?? ME];
        case "eth_call": {
          const sel = (arg.data as string).slice(0, 10);
          if (sel === toFunctionSelector("balanceOf(address)")) return `0x${o.balance.toString(16)}`;
          if (sel === toFunctionSelector("allowance(address,address)")) return `0x${o.allowance.toString(16)}`;
          throw new Error(`unexpected call ${sel}`);
        }
        case "eth_sendTransaction": {
          if (unauthorized > 0) { unauthorized--; throw Object.assign(new Error("The requested account and/or method has not been authorized by the user."), { code: 4100 }); }
          sent.push({ to: arg.to, data: arg.data, gas: arg.gas });
          if (arg.to === T.usdc && o.switchChainAfterApprove) chain = o.switchChainAfterApprove;
          return `0x${String(sent.length).padStart(64, "0")}`;
        }
        case "eth_getTransactionReceipt": {
          const isApprove = sent[Number(BigInt(params![0] as string)) - 1]?.to === T.usdc;
          return { status: isApprove && o.failApprove ? "0x0" : "0x1" };
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { p, sent, calls };
}

describe("deposit flow", () => {
  it("approves the exact amount, then deposits for the depositor", async () => {
    const w = fakeWallet({ balance: 10_000_000n, allowance: 0n });
    const steps: DepositStep[] = [];
    await deposit(w.p, T, ME, 5_000_000n, (s) => steps.push(s));
    expect(w.sent.map((t) => t.to)).toEqual([T.usdc, T.gatewayWallet]);
    expect(w.sent[0]!.data).toBe(approveData(T.gatewayWallet, 5_000_000n));
    expect(w.sent[1]!.data).toBe(depositForData(T.usdc, T.depositor, 5_000_000n));
    expect(w.sent[1]!.gas).toBe("0x1d4c0");
    expect(steps).toEqual(["checking", "approve", "approving", "deposit", "depositing"]);
  });

  it("skips approve when the allowance already covers it", async () => {
    const w = fakeWallet({ balance: 10_000_000n, allowance: 5_000_000n });
    await deposit(w.p, T, ME, 5_000_000n, () => {});
    expect(w.sent.map((t) => t.to)).toEqual([T.gatewayWallet]);
  });

  it("refuses on the wrong network, a changed account, or too little USDC, before sending anything", async () => {
    for (const [w, msg] of [
      [fakeWallet({ balance: 10_000_000n, allowance: 0n, chainId: 1 }), /isn't on Arc Testnet/],
      [fakeWallet({ balance: 10_000_000n, allowance: 0n, account: "0x2222222222222222222222222222222222222222" }), /account changed/],
      [fakeWallet({ balance: 1_000_000n, allowance: 0n }), /doesn't have that much/],
    ] as const) {
      await expect(deposit(w.p, T, ME, 5_000_000n, () => {})).rejects.toThrow(msg);
      expect(w.sent).toEqual([]);
    }
  });

  it("stops before the deposit if MetaMask switches network after approving", async () => {
    const w = fakeWallet({ balance: 10_000_000n, allowance: 0n, switchChainAfterApprove: 1 });
    await expect(deposit(w.p, T, ME, 5_000_000n, () => {})).rejects.toThrow(/isn't on Arc Testnet/);
    expect(w.sent.map((t) => t.to)).toEqual([T.usdc]);
  });

  it("stops if the approve reverts", async () => {
    const w = fakeWallet({ balance: 10_000_000n, allowance: 0n, failApprove: true });
    await expect(deposit(w.p, T, ME, 5_000_000n, () => {})).rejects.toThrow(/failed on Arc/);
    expect(w.sent.map((t) => t.to)).toEqual([T.usdc]);
  });
});

describe("MetaMask 4100 (account or network not authorized for this page)", () => {
  it("reconnects, switches back to Arc, re-checks, and retries once", async () => {
    const w = fakeWallet({ balance: 10_000_000n, allowance: 0n, unauthorizedSends: 1 });
    await deposit(w.p, T, ME, 5_000_000n, () => {});
    expect(w.sent.map((t) => t.to)).toEqual([T.usdc, T.gatewayWallet]);
    const i = w.calls.indexOf("wallet_requestPermissions");
    expect(i).toBeGreaterThan(-1);
    expect(w.calls.slice(i, i + 2)).toEqual(["wallet_requestPermissions", "wallet_switchEthereumChain"]);
  });

  it("gives up after a second refusal, with a plain explanation", async () => {
    const w = fakeWallet({ balance: 10_000_000n, allowance: 0n, unauthorizedSends: 2 });
    const err = await deposit(w.p, T, ME, 5_000_000n, () => {}).catch((e) => e);
    expect(err.code).toBe(4100);
    expect(walletError(err)).toMatch(/hasn't allowed this page/);
    expect(w.sent).toEqual([]);
  });
});

describe("walletError", () => {
  it("speaks plainly about MetaMask codes", () => {
    expect(walletError({ code: 4001, message: "User rejected the request." })).toBe("You cancelled in MetaMask.");
    expect(walletError({ code: -32002 })).toMatch(/already has a request open/);
    expect(walletError(new Error("boom\nstack"))).toBe("boom");
  });
});
