import { AppError } from "../errors/AppError.js";

const origin = "https://sandbox.shurjopayment.com";
export class CheckoutNotSubmitted extends Error {}
export function minorUnits(value: unknown): bigint {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2}0*)?$/.test(text))
    throw new Error("Invalid exact BDT amount");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}
export function sandboxConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.PAYMENT_SANDBOX_ENABLED === "true";
  const demoMode = env.NIBASH_DEMO_MODE === "true";
  const provider =
    env.PAYMENT_SANDBOX_PROVIDER ?? (demoMode ? "simulated" : "shurjopay-sandbox");
  if (enabled && demoMode && provider !== "simulated")
    throw new Error("Student demo payments require the simulated provider");
  if (
    enabled &&
    !["development", "test"].includes(env.NODE_ENV ?? "") &&
    !(env.NODE_ENV === "production" && demoMode && provider === "simulated")
  )
    throw new Error(
      "Hosted sandbox payments require explicit NIBASH_DEMO_MODE and the simulated provider",
    );
  if (enabled && !["shurjopay-sandbox", "simulated"].includes(provider))
    throw new Error("Unsupported test provider");
  return {
    enabled,
    demoMode,
    provider,
    username: env.SHURJOPAY_SANDBOX_USERNAME,
    password: env.SHURJOPAY_SANDBOX_PASSWORD,
    prefix: env.SHURJOPAY_SANDBOX_PREFIX,
    returnUrl: env.PAYMENT_SANDBOX_RETURN_URL,
  };
}
export interface AttemptIdentity {
  id: string;
  payment_id: number;
  provider_order_id: string;
  merchant_order_id: string;
  amount: string;
}
export type Verification = Record<string, unknown>;
export function validateVerification(a: AttemptIdentity, v: Verification) {
  if (
    v.order_id !== a.provider_order_id ||
    v.customer_order_id !== a.merchant_order_id ||
    v.currency !== "BDT" ||
    String(v.value1) !== String(a.payment_id) ||
    v.value2 !== a.id ||
    minorUnits(v.amount) !== minorUnits(a.amount)
  )
    throw new Error("Provider verification mismatch");
  if (String(v.sp_code) === "1000") return "succeeded";
  if (String(v.sp_code) === "1001") return "failed";
  if (String(v.sp_code) === "1002") return "cancelled";
  return "pending";
}
export function safeCheckoutUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    ![
      "sandbox.shurjopayment.com",
      "sandbox.securepay.shurjopayment.com",
    ].includes(url.hostname)
  )
    throw new Error("Unexpected sandbox checkout origin");
  return url.href;
}
async function post(path: string, body: unknown, token?: string): Promise<any> {
  const response = await fetch(origin + path, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Sandbox provider unavailable");
  return response.json();
}
async function authenticate() {
  const config = sandboxConfig();
  if (
    !config.enabled ||
    !config.username ||
    !config.password ||
    !config.prefix ||
    !config.returnUrl
  )
    throw new AppError(503, "Sandbox is not configured");
  const callback = new URL(config.returnUrl);
  if (
    callback.protocol !== "https:" &&
    !(
      callback.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(callback.hostname)
    )
  )
    throw new Error("Sandbox return URL must use HTTPS or loopback");
  const auth = await post("/api/get_token", {
    username: config.username,
    password: config.password,
  });
  if (
    !auth.token ||
    !auth.store_id ||
    !["200", "1000"].includes(String(auth.sp_code))
  )
    throw new Error("Sandbox authentication failed");
  return { config, auth };
}
export interface SandboxProvider {
  initiate(a: {
    id: string;
    payment_id: number;
    merchant_order_id: string;
    amount: string;
  }): Promise<{ provider_order_id: string; checkout_url: string | null }>;
  verify(orderId: string): Promise<Verification>;
}
export const shurjoPaySandbox: SandboxProvider = {
  async initiate(a) {
    const { config, auth } = await authenticate().catch(() => {
      throw new CheckoutNotSubmitted(
        "Sandbox authentication/configuration failed before checkout",
      );
    });
    const result = await post(
      "/api/secret-pay",
      {
        token: auth.token,
        store_id: auth.store_id,
        prefix: config.prefix,
        return_url: config.returnUrl,
        cancel_url: config.returnUrl,
        amount: a.amount,
        order_id: a.merchant_order_id,
        currency: "BDT",
        customer_name: "Nibash Synthetic Tenant",
        customer_address: "Synthetic demo address",
        customer_city: "Dhaka",
        customer_email: "tenant@example.test",
        customer_phone: "01700000000",
        client_ip: "127.0.0.1",
        value1: String(a.payment_id),
        value2: a.id,
      },
      auth.token,
    );
    if (
      typeof result.sp_order_id !== "string" ||
      !result.sp_order_id ||
      result.customer_order_id !== a.merchant_order_id ||
      result.currency !== "BDT" ||
      minorUnits(result.amount) !== minorUnits(a.amount)
    )
      throw new Error("Sandbox initiation mismatch");
    return {
      provider_order_id: result.sp_order_id,
      checkout_url: safeCheckoutUrl(result.checkout_url),
    };
  },
  async verify(orderId) {
    const { auth } = await authenticate();
    const result = await post(
      "/api/verification",
      { order_id: orderId },
      auth.token,
    );
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      !result[0] ||
      typeof result[0] !== "object"
    )
      throw new Error("Invalid sandbox verification");
    // Retain only reconciliation fields, never card details, tokens or personal data.
    return Object.fromEntries(
      [
        "order_id",
        "customer_order_id",
        "amount",
        "currency",
        "sp_code",
        "value1",
        "value2",
      ].map((key) => [key, result[0][key]]),
    );
  },
};
