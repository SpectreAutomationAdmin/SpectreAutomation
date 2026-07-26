// Phase 8E — Hardware / IoT adapter architecture.
//
// Device registry + event-ingestion seam. No real protocols implemented;
// every adapter is a stub that can be wired in Phase 9. The schema records
// devices, ingestion events, status snapshots, and assignments.

import { z } from "zod";
import { createHash } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";
import { ConflictError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------
export interface HardwareAdapter {
  kind: string;
  // Translate a raw inbound payload into a DeviceEvent record. Adapters are
  // responsible for verifying the device's auth token and shape.
  ingestEvent(args: {
    clubId: string;
    deviceSerial: string;
    authToken: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  }): Promise<{ accepted: boolean; reason?: string; eventId?: string }>;
}

// Default adapter — accepts heartbeat / event payloads after verifying that
// the device's `authTokenHash` matches the supplied token.
export const defaultHardwareAdapter: HardwareAdapter = {
  kind: "default",
  async ingestEvent({ clubId, deviceSerial, authToken, eventType, metadata, occurredAt }) {
    const device = await prisma.hardwareDevice.findUnique({
      where: { clubId_serial: { clubId, serial: deviceSerial } },
    });
    if (!device) return { accepted: false, reason: "unknown device" };
    if (device.status === "DISABLED" || device.status === "LOST") return { accepted: false, reason: `device status ${device.status}` };
    if (device.authTokenHash) {
      const incomingHash = createHash("sha256").update(authToken).digest("hex");
      if (incomingHash !== device.authTokenHash) return { accepted: false, reason: "auth token mismatch" };
    }
    const event = await prisma.deviceEvent.create({
      data: {
        clubId, deviceId: device.id, kind: eventType === "HEARTBEAT" ? "HEARTBEAT" : "EVENT",
        eventType, metaJson: metadata ? JSON.stringify(metadata) : null,
        occurredAt: occurredAt ?? new Date(),
      },
    });
    if (eventType === "HEARTBEAT") {
      await prisma.deviceStatus.create({
        data: {
          clubId, deviceId: device.id, online: true, lastHeartbeat: event.occurredAt,
          metaJson: metadata ? JSON.stringify(metadata) : null,
        },
      });
    }
    return { accepted: true, eventId: event.id };
  },
};

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------
export const registerSchema = z.object({
  serial: z.string().trim().min(1).max(120),
  kind: z.enum(["GPS_BAG_TAG", "DOOR_ACCESS", "LOCKER", "BEVERAGE_CART_RADIO", "DRIVING_RANGE_CAMERA", "PARKING_GATE", "GEOFENCE"]),
  label: z.string().trim().max(120).optional().nullable(),
  vendor: z.string().trim().max(120).optional().nullable(),
  model: z.string().trim().max(120).optional().nullable(),
  authToken: z.string().trim().optional().nullable(), // raw token; we store only sha256
});

export async function registerDevice(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const authTokenHash = d.authToken ? createHash("sha256").update(d.authToken).digest("hex") : null;
  const device = await prisma.hardwareDevice.upsert({
    where: { clubId_serial: { clubId, serial: d.serial } },
    update: { kind: d.kind, label: d.label ?? null, vendor: d.vendor ?? null, model: d.model ?? null, ...(authTokenHash ? { authTokenHash } : {}), status: "ACTIVE" },
    create: { clubId, serial: d.serial, kind: d.kind, label: d.label ?? null, vendor: d.vendor ?? null, model: d.model ?? null, authTokenHash, status: "ACTIVE" },
  });
  await audit(principal, { action: "device.register", entityType: "HardwareDevice", entityId: device.id, clubId, after: { serial: d.serial, kind: d.kind } });
  return device;
}

export async function disableDevice(principal: Principal, deviceId: string, reason?: string) {
  const device = await prisma.hardwareDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new ConflictError("device not found");
  requirePermission(principal, device.clubId, "settings:write");
  await prisma.hardwareDevice.update({ where: { id: deviceId }, data: { status: "DISABLED" } });
  await audit(principal, { action: "device.disable", entityType: "HardwareDevice", entityId: deviceId, clubId: device.clubId, after: { status: "DISABLED", reason } });
}

export async function assignDevice(principal: Principal, args: { deviceId: string; subjectType: string; subjectId: string; kind?: string }) {
  const device = await prisma.hardwareDevice.findUnique({ where: { id: args.deviceId } });
  if (!device) throw new ConflictError("device not found");
  requirePermission(principal, device.clubId, "settings:write");
  const assignment = await prisma.deviceAssignment.create({
    data: { clubId: device.clubId, deviceId: args.deviceId, kind: args.kind ?? "MEMBER", subjectType: args.subjectType, subjectId: args.subjectId },
  });
  await audit(principal, { action: "device.assign", entityType: "DeviceAssignment", entityId: assignment.id, clubId: device.clubId, after: { deviceId: args.deviceId, subjectType: args.subjectType, subjectId: args.subjectId } });
  return assignment;
}

export async function listDevices(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.hardwareDevice.findMany({
    where: tenantWhere(principal, clubId),
    orderBy: { createdAt: "desc" },
    include: { statuses: { take: 1, orderBy: { observedAt: "desc" } } },
  });
}

// ---------------------------------------------------------------------------
// Public ingestion hook (consumed by /api/hardware/events endpoint)
// ---------------------------------------------------------------------------
let activeHwAdapter: HardwareAdapter = defaultHardwareAdapter;
export function setHardwareAdapter(a: HardwareAdapter) { activeHwAdapter = a; }
export async function ingestDeviceEvent(args: Parameters<HardwareAdapter["ingestEvent"]>[0]) {
  return activeHwAdapter.ingestEvent(args);
}
