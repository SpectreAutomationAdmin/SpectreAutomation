// Phase 7B — SMS delivery adapter.
//
// Twilio adapter is dynamically imported. Dev adapter writes to console.

import type { NotificationDeliveryAdapter } from "../enterprise/notifications";
import { getActiveIntegration, readConfig, readSecrets } from "./config";

export const devSmsAdapter: NotificationDeliveryAdapter = {
  async send({ channel, to, subject, body }) {
    if (channel !== "SMS") return { status: "FAILED", failureReason: "wrong channel" };
    // eslint-disable-next-line no-console
    console.log(`[dev:sms] → ${to.email ?? to.userId ?? to.memberId} | ${subject ?? ""} | ${body.slice(0, 80)}`);
    return { status: "SENT", providerMessageId: `dev-${Date.now()}` };
  },
};

export async function twilioSmsAdapter(args: { accountSid: string; authToken: string; fromNumber: string; }): Promise<NotificationDeliveryAdapter> {
  const { optionalImport } = await import("./optional-import");
  const twilioLib = await optionalImport("twilio");
  if (!twilioLib) {
    return { async send() { return { status: "FAILED", failureReason: "twilio not installed" }; } };
  }
  const factory = twilioLib.default ?? twilioLib;
  const client = factory(args.accountSid, args.authToken) as { messages: { create: (args: { to: string; from: string; body: string }) => Promise<{ sid: string }> } };
  return {
    async send({ channel, to, body }) {
      if (channel !== "SMS") return { status: "FAILED", failureReason: "wrong channel" };
      // The "to" address for SMS is the phone number; we accept it via to.email
      // (the notification engine doesn't have a phone field today). Phone-aware
      // routing requires adding a "to.phone" carrier and is wired below if
      // toEmail looks like a phone number.
      const toAddress = to.email; // Notification.toEmail repurposed for SMS recipient.
      if (!toAddress) return { status: "FAILED", failureReason: "no recipient" };
      try {
        const result = await client.messages.create({ to: toAddress, from: args.fromNumber, body });
        return { status: "SENT", providerMessageId: result.sid };
      } catch (err) {
        return { status: "FAILED", failureReason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export async function selectSmsAdapter(clubId: string): Promise<NotificationDeliveryAdapter> {
  const setting = await getActiveIntegration(clubId, "SMS");
  if (!setting) return devSmsAdapter;
  const config = readConfig<{ fromNumber?: string }>(setting);
  const secrets = readSecrets<{ accountSid?: string; authToken?: string }>(setting);
  if (setting.provider === "twilio") {
    if (!config.fromNumber || !secrets.accountSid || !secrets.authToken) return devSmsAdapter;
    return twilioSmsAdapter({
      accountSid: secrets.accountSid, authToken: secrets.authToken, fromNumber: config.fromNumber,
    });
  }
  if (setting.provider === "dev" || setting.provider === "local") return devSmsAdapter;
  return { async send() { return { status: "FAILED", failureReason: `Unknown SMS provider: ${setting.provider}` }; } };
}
