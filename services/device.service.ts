import "server-only";
import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/lib/action-state";
import { recordAudit } from "./audit.service";

export type DeviceInput = {
  name: string;
  ip: string;
  port: number;
  commKey: number;
};

function normalize(input: DeviceInput): DeviceInput {
  return {
    name: input.name.trim(),
    ip: input.ip.trim(),
    port: Number(input.port),
    commKey: Number(input.commKey),
  };
}

function assertValid(input: DeviceInput) {
  if (!input.name) throw new ServiceError("Device name is required.");
  if (input.name.length > 80)
    throw new ServiceError("Device name is too long.");
  if (!input.ip) throw new ServiceError("IP address is required.");
  // Basic IPv4 check; enough for ZKTeco devices on office LAN.
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(input.ip)) {
    throw new ServiceError("Enter a valid IPv4 address.");
  }
  const parts = input.ip.split(".").map(Number);
  if (parts.some((p) => p < 0 || p > 255)) {
    throw new ServiceError("Enter a valid IPv4 address.");
  }
  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
    throw new ServiceError("Port must be between 1 and 65535.");
  }
  if (!Number.isInteger(input.commKey) || input.commKey < 0) {
    throw new ServiceError("Comm key must be 0 or a positive integer.");
  }
}

export function listDevices() {
  return prisma.device.findMany({ orderBy: { createdAt: "asc" } });
}

export async function listDevicesForAdmin() {
  const [devices, statuses] = await Promise.all([
    prisma.device.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.syncStatus.findMany(),
  ]);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return devices.map((d) => ({ ...d, sync: byId.get(d.id) ?? null }));
}

export async function createDevice(input: DeviceInput) {
  const data = normalize(input);
  assertValid(data);
  const exists = await prisma.device.findUnique({
    where: { ip_port: { ip: data.ip, port: data.port } },
    select: { id: true, name: true },
  });
  if (exists) {
    throw new ServiceError(
      `A device already uses ${data.ip}:${data.port} (${exists.name}).`,
    );
  }
  const created = await prisma.device.create({ data: { ...data, isActive: true } });
  await recordAudit({
    action: "device.create",
    entity: "Device",
    entityId: created.id,
    summary: `Added biometric device ${created.name} (${created.ip}:${created.port})`,
    after: { name: created.name, ip: created.ip, port: created.port, isActive: created.isActive },
  });
  return created;
}

export async function updateDevice(id: string, input: DeviceInput) {
  const data = normalize(input);
  assertValid(data);
  const before = await prisma.device.findUnique({ where: { id } });
  if (!before) throw new ServiceError("Device not found.");

  const clash = await prisma.device.findUnique({
    where: { ip_port: { ip: data.ip, port: data.port } },
    select: { id: true, name: true },
  });
  if (clash && clash.id !== id) {
    throw new ServiceError(
      `A device already uses ${data.ip}:${data.port} (${clash.name}).`,
    );
  }

  const updated = await prisma.device.update({ where: { id }, data });
  await recordAudit({
    action: "device.update",
    entity: "Device",
    entityId: id,
    summary: `Updated biometric device ${updated.name} (${updated.ip}:${updated.port})`,
    before: { name: before.name, ip: before.ip, port: before.port, commKey: before.commKey, isActive: before.isActive },
    after: { name: updated.name, ip: updated.ip, port: updated.port, commKey: updated.commKey, isActive: updated.isActive },
  });
  return updated;
}

export async function setDeviceActive(id: string, isActive: boolean) {
  const before = await prisma.device.findUnique({ where: { id } });
  if (!before) throw new ServiceError("Device not found.");
  const updated = await prisma.device.update({ where: { id }, data: { isActive } });
  await recordAudit({
    action: isActive ? "device.activate" : "device.deactivate",
    entity: "Device",
    entityId: id,
    summary: `${isActive ? "Activated" : "Deactivated"} biometric device ${updated.name}`,
    before: { isActive: before.isActive },
    after: { isActive: updated.isActive },
  });
  return updated;
}

export async function deleteDevice(id: string) {
  const before = await prisma.device.findUnique({ where: { id } });
  if (!before) throw new ServiceError("Device not found.");
  await prisma.device.delete({ where: { id } });
  await recordAudit({
    action: "device.delete",
    entity: "Device",
    entityId: id,
    summary: `Deleted biometric device ${before.name} (${before.ip}:${before.port})`,
    before: { name: before.name, ip: before.ip, port: before.port, isActive: before.isActive },
  });
}
