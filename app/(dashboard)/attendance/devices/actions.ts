"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { toActionError, type ActionState } from "@/lib/action-state";
import {
  createDevice,
  deleteDevice,
  setDeviceActive,
  updateDevice,
} from "@/services/device.service";

function revalidate() {
  revalidatePath("/attendance/devices");
  revalidatePath("/dashboard");
}

function readDeviceInput(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    ip: String(formData.get("ip") ?? ""),
    port: Number(formData.get("port") ?? 4370),
    commKey: Number(formData.get("commKey") ?? 0),
  };
}

export async function createDeviceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission(PERMISSIONS.ATTENDANCE_SETTINGS);
  try {
    await createDevice(readDeviceInput(formData));
  } catch (e) {
    return toActionError(e);
  }
  revalidate();
  return { ok: true, message: "Device added." };
}

export async function updateDeviceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission(PERMISSIONS.ATTENDANCE_SETTINGS);
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing device id." };
  try {
    await updateDevice(id, readDeviceInput(formData));
  } catch (e) {
    return toActionError(e);
  }
  revalidate();
  return { ok: true, message: "Device updated." };
}

export async function toggleDeviceActiveAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission(PERMISSIONS.ATTENDANCE_SETTINGS);
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (!id) return { error: "Missing device id." };
  try {
    await setDeviceActive(id, active);
  } catch (e) {
    return toActionError(e);
  }
  revalidate();
  return { ok: true, message: active ? "Device activated." : "Device deactivated." };
}

export async function deleteDeviceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requirePermission(PERMISSIONS.ATTENDANCE_SETTINGS);
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing device id." };
  try {
    await deleteDevice(id);
  } catch (e) {
    return toActionError(e);
  }
  revalidate();
  return { ok: true, message: "Device deleted." };
}