import "dotenv/config";
import { createHash } from "node:crypto";
import { ZKTecoClient } from "@graphland/zkteco";
import { prisma } from "../lib/prisma";
import { processDevicePunches } from "../services/device-attendance.service";
import {
  recordSyncFailure,
  recordSyncSuccess,
} from "../services/sync-status.service";
import {
  parseDeviceTimeMode,
  toOfficeClock,
} from "../lib/attendance/office-clock";

const POLL_INTERVAL_MS = Number(process.env.ZK_POLL_INTERVAL_MS ?? 60_000);
// `npm run sync -- --dry-run` reads every configured device and reports what it sees,
// without writing punches, attendance or heartbeats. Useful after changing device config.
const DRY_RUN = process.argv.includes("--dry-run");
// `npm run sync -- --once` does one real cycle (read, save, process, heartbeat) and exits.
// Handy for a one-off backfill or for a scheduler that starts the script repeatedly.
const ONCE = process.argv.includes("--once");
// "local" (default): the device library builds each punch time from local parts, in this
// computer's time zone. Use ZK_TIME_MODE=utc only if the first record printed at startup
// shows the device's wall-clock time with a trailing Z.
const TIME_MODE = parseDeviceTimeMode(process.env.ZK_TIME_MODE);

/** Devices whose time-check line has already been printed. */
const checkedTime = new Set<string>();

type DeviceConfig = {
  /** Heartbeat id shown on the dashboard; also part of every punch's dedupe key. */
  id: string;
  ip: string;
  port: number;
  commKey: number;
};

/**
 * Devices are read from `ZK_DEVICES`, a JSON list, so one poller can serve a whole office:
 *
 *   ZK_DEVICES='[
 *     {"id":"gate-left","ip":"192.168.1.101","port":4370,"commKey":0},
 *     {"id":"gate-right","ip":"192.168.1.102"}
 *   ]'
 *
 * `ZK_DEVICE_IP` (with `ZK_DEVICE_ID`, `ZK_DEVICE_PORT`, `ZK_COMM_KEY`) still works for a
 * single-device install.
 */
function readDevices(): DeviceConfig[] {
  const raw = process.env.ZK_DEVICES?.trim();

  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("ZK_DEVICES must be valid JSON, for example a list of {id, ip} objects");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("ZK_DEVICES must be a non-empty JSON list");
    }

    const seen = new Set<string>();
    return parsed.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`ZK_DEVICES[${index}] must be an object like {"id":"gate","ip":"192.168.1.10"}`);
      }
      const item = entry as Record<string, unknown>;
      const ip = typeof item.ip === "string" ? item.ip.trim() : "";
      if (!ip) throw new Error(`ZK_DEVICES[${index}].ip is required`);

      // Default the heartbeat id to the last IP octet: readable, and unique per device.
      const id =
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `device-${ip.split(".").pop() ?? index}`;
      if (seen.has(id)) {
        throw new Error(`Duplicate device id "${id}" in ZK_DEVICES`);
      }
      seen.add(id);

      const device: DeviceConfig = {
        id,
        ip,
        port: Number(item.port ?? process.env.ZK_DEVICE_PORT ?? 4370),
        commKey: Number(item.commKey ?? process.env.ZK_COMM_KEY ?? 0),
      };
      if (!Number.isInteger(device.port) || device.port <= 0 || device.port > 65535) {
        throw new Error(`ZK_DEVICES[${index}].port is not a valid TCP port`);
      }
      if (!Number.isInteger(device.commKey) || device.commKey < 0) {
        throw new Error(`ZK_DEVICES[${index}].commKey must be a non-negative integer`);
      }
      return device;
    });
  }

  const ip = process.env.ZK_DEVICE_IP;
  if (!ip) {
    throw new Error(
      "Set ZK_DEVICES (JSON list) or ZK_DEVICE_IP in .env to reach the attendance devices",
    );
  }
  return [
    {
      id: process.env.ZK_DEVICE_ID ?? `device-${ip.split(".").pop() ?? "main"}`,
      ip,
      port: Number(process.env.ZK_DEVICE_PORT ?? 4370),
      commKey: Number(process.env.ZK_COMM_KEY ?? 0),
    },
  ];
}

const DEVICES = readDevices();

type DeviceRecord = {
  userSn?: number;
  deviceUserId: string;
  recordTime: Date;
  punch?: number;
  punchLabel?: string;
  status?: number;
  statusLabel?: string;
  [key: string]: unknown;
};

function normalizeRecord(device: DeviceConfig, record: DeviceRecord) {
  const deviceUserId = String(record.deviceUserId ?? "").trim();
  const rawRecordTime = new Date(record.recordTime);

  if (!deviceUserId || Number.isNaN(rawRecordTime.getTime())) {
    console.warn(`[${device.id}] Skipping invalid device record:`, record);
    return null;
  }

  // Preserve the original SDK timestamp for stable deduplication.
  const originalRecordTime = rawRecordTime.toISOString();

  // Convert the timestamp to the application's office-clock convention.
  const punchedAt = toOfficeClock(rawRecordTime, TIME_MODE);

  // The device id is part of the key, so the same person punching on two machines keeps both
  // punches while a re-read of one machine never duplicates anything.
  const sourceKey = createHash("sha256")
    .update(
      JSON.stringify([
        device.id,
        record.userSn ?? null,
        deviceUserId,
        originalRecordTime,
        record.punch ?? null,
        record.status ?? null,
      ]),
    )
    .digest("hex");

  return {
    deviceId: device.id,
    deviceUserId,
    punchedAt,
    punchState: record.punch ?? null,
    verifyMode: record.status ?? null,
    sourceKey,
    rawData: JSON.parse(JSON.stringify(record)),
  };
}

type DeviceRun = { device: DeviceConfig; retrieved: number; inserted: number };

async function syncDevice(device: DeviceConfig): Promise<DeviceRun> {
  const client = new ZKTecoClient({
    ip: device.ip,
    port: device.port,
    timeout: 10_000,
    commKey: device.commKey,
  });

  let connected = false;

  try {
    console.log(
      `[${new Date().toISOString()}] [${device.id}] Connecting to ${device.ip}:${device.port}`,
    );

    await client.connect();
    connected = true;

    const info = await client.getInfo();
    console.log(`[${device.id}] Device information:`, info);

    const records = (await client.getAttendances()) as DeviceRecord[];
    console.log(`[${device.id}] Retrieved ${records.length} attendance records.`);

    // Printed once per device so the time handling can be checked against the device screen.
    if (!checkedTime.has(device.id) && records.length > 0) {
      const last = records[records.length - 1];
      const raw = new Date(last.recordTime);
      console.log(
        `[${device.id}] Time check (latest punch of user ${last.deviceUserId}): ` +
          `library gave ${raw.toString()} = ${raw.toISOString()}; ` +
          `saved as office time ${toOfficeClock(raw, TIME_MODE).toISOString()} ` +
          `(mode "${TIME_MODE}"). The saved time should equal the time shown on the device.`,
      );
      checkedTime.add(device.id);
    }

    let inserted = 0;
    let invalid = 0;

    for (let i = 0; i < records.length; i += 500) {
      const normalized = records
        .slice(i, i + 500)
        .map((record) => normalizeRecord(device, record));

      invalid += normalized.filter((record) => record === null).length;

      const validRecords = normalized.filter(
        (record): record is NonNullable<typeof record> => record !== null,
      );

      if (!validRecords.length) continue;

      if (DRY_RUN) {
        // Nothing is written; the count is how many rows were read and looked valid.
        inserted += validRecords.length;
        continue;
      }

      const result = await prisma.devicePunch.createMany({
        data: validRecords,
        skipDuplicates: true,
      });

      inserted += result.count;
    }

    console.log(
      `[${device.id}] Sync finished: retrieved=${records.length}, ` +
        `inserted=${inserted}, invalid=${invalid}` +
        (DRY_RUN ? " (dry run: nothing written)" : ""),
    );

    return { device, retrieved: records.length, inserted };
  } finally {
    if (connected) {
      await client.disconnect();
    }
  }
}

let stopping = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let attendanceInitialized = false;

/**
 * True once attendance history has been built, so a restart only needs the recent window.
 * Re-reading four years of punches and recomputing the whole history takes minutes on a cold
 * database, and a slow first round is where a wedged one hides. Either a completed round
 * (its heartbeat) or existing attendance rows prove the history is there.
 */
async function attendanceInitializedAlready() {
  const [sync, attendance] = await Promise.all([
    prisma.syncStatus.findFirst({
      where: { lastSuccessAt: { not: null } },
      select: { id: true },
    }),
    prisma.attendance.findFirst({ select: { id: true } }),
  ]);
  return sync !== null || attendance !== null;
}

async function poll() {
  if (stopping || running) return;

  running = true;

  try {
    const runs: DeviceRun[] = [];
    const failures: { device: DeviceConfig; error: string }[] = [];

    // Sequential on purpose: four small devices finish in seconds, and one unreachable
    // machine cannot slow the others down.
    for (const device of DEVICES) {
      if (stopping) break;
      try {
        runs.push(await syncDevice(device));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${device.id}] Sync failed:`, error);
        failures.push({ device, error: message });
      }
    }

    let processingError: string | null = null;

    if (!DRY_RUN && runs.length > 0) {
      // Full history once after startup, then only the last two days on every poll. Running it
      // every time (not only when new punches arrive) lets a day close by itself after the shift
      // ends: employees who never punched become Absent, and a lone check-in turns into Missing
      // punch. It runs once per poll even with several devices.
      try {
        if (!attendanceInitialized) {
          attendanceInitialized = await attendanceInitializedAlready();
        }
        await processDevicePunches(attendanceInitialized ? { sinceDays: 2 } : {});
        attendanceInitialized = true;
      } catch (error) {
        processingError = error instanceof Error ? error.message : String(error);
        console.error("Attendance processing failed:", error);
      }
    }

    // A dry run only reads; heartbeats would make the dashboard claim a real sync happened.
    if (!DRY_RUN) {
      // Heartbeats are written after processing, so a green badge means "punches are in the
      // database and attendance has been recalculated", not merely "the device answered".
      for (const run of runs) {
        try {
          if (processingError) {
            await recordSyncFailure(
              run.device.id,
              processingError,
              Math.round(POLL_INTERVAL_MS / 1000),
            );
          } else {
            await recordSyncSuccess(
              run.device.id,
              run.retrieved,
              run.inserted,
              Math.round(POLL_INTERVAL_MS / 1000),
            );
          }
        } catch (heartbeatError) {
          console.error(`[${run.device.id}] Could not record sync state:`, heartbeatError);
        }
      }

      for (const failure of failures) {
        try {
          await recordSyncFailure(
            failure.device.id,
            failure.error,
            Math.round(POLL_INTERVAL_MS / 1000),
          );
        } catch (heartbeatError) {
          console.error(`[${failure.device.id}] Could not record sync failure:`, heartbeatError);
        }
      }
    }
  } finally {
    running = false;
  }

  if (DRY_RUN || ONCE) {
    // A dry run or a one-off pass is a single cycle: report, disconnect and exit instead of
    // polling. A dry run never wrote anything; `--once` did one real sync.
    await shutdown();
    return;
  }

  if (!stopping) {
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;

  if (timer) clearTimeout(timer);

  console.log("Stopping synchronization worker...");

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await prisma.$disconnect();
  console.log("Worker stopped.");
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.log(
  `Starting attendance synchronization for ${DEVICES.length} device(s): ` +
    DEVICES.map((device) => `${device.id} (${device.ip}:${device.port})`).join(", ") +
    (DRY_RUN ? " [dry run: no writes]" : ONCE ? " [single pass]" : ""),
);
void poll();
