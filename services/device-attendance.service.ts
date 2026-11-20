import { prisma } from "../lib/prisma";
import {
  evaluateDay,
  formatMinutes,
  toRuleConfig,
  type DayType,
} from "../lib/attendance/attendance-rules";
import { normalizeBiometricId } from "../lib/attendance/biometric-id";
import { evaluateLiveDay } from "../lib/attendance/live-day";
import { officeNow } from "../lib/attendance/office-clock";
import type { AttendanceStatus } from "../lib/generated/prisma/client";
import { syncApprovedLeavesToAttendance } from "./leave-attendance.service";

const DAY_MS = 86_400_000;
const SOURCE = "Source: uFace800";
const iso = (d: Date) => d.toISOString().slice(0, 10);

type AttendanceFields = {
  checkIn: Date | null;
  checkOut: Date | null;
  workingMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  status: AttendanceStatus;
  remarks: string;
  punches: string | null;
  sourceBatchId: null;
};

type AttendanceWrite = {
  employeeId: string;
  date: Date;
  data: AttendanceFields;
};

const sameMoment = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** True when the stored row does not already hold exactly what this round computed. */
function differsFromStored(
  stored: {
    checkIn: Date | null;
    checkOut: Date | null;
    workingMinutes: number;
    lateMinutes: number;
    earlyLeaveMinutes: number;
    overtimeMinutes: number;
    status: AttendanceStatus;
    remarks: string | null;
    punches: string | null;
  },
  next: AttendanceFields,
) {
  return (
    !sameMoment(stored.checkIn, next.checkIn) ||
    !sameMoment(stored.checkOut, next.checkOut) ||
    stored.workingMinutes !== next.workingMinutes ||
    stored.lateMinutes !== next.lateMinutes ||
    stored.earlyLeaveMinutes !== next.earlyLeaveMinutes ||
    stored.overtimeMinutes !== next.overtimeMinutes ||
    stored.status !== next.status ||
    stored.remarks !== next.remarks ||
    stored.punches !== next.punches
  );
}

export async function processDevicePunches(
  options: { sinceDays?: number } = {},
) {
  const settings = await prisma.attendanceSettings.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
  const cfg = toRuleConfig(settings);

  const { todayMs, minutes: nowMinutes } = officeNow();
  const todayIso = iso(new Date(todayMs));
  const since =
    options.sinceDays === undefined
      ? undefined
      : new Date(todayMs - options.sinceDays * DAY_MS);

  const [employees, punches] = await Promise.all([
    prisma.employee.findMany({
      select: {
        id: true,
        biometricId: true,
        joiningDate: true,
        isActive: true,
      },
    }),
    prisma.devicePunch.findMany({
      where: since ? { punchedAt: { gte: since } } : {},
      orderBy: [{ punchedAt: "asc" }, { deviceUserId: "asc" }],
      select: { deviceUserId: true, punchedAt: true },
    }),
  ]);

  console.log(
    `uFace800 attendance: loaded ${punches.length} punches ` +
      `(${since ? `since ${iso(since)}` : "full history"})`,
  );

  // "005" on the device and "5" on the employee are the same person (as in the Excel import).
  const employeeByDeviceId = new Map<string, (typeof employees)[number]>();
  for (const employee of employees) {
    const key = normalizeBiometricId(employee.biometricId);
    if (key) employeeByDeviceId.set(key, employee);
  }

  type Group = { employeeId: string; dateIso: string; times: number[] };
  const groups = new Map<string, Group>();
  const unmatchedIds = new Set<string>();
  let firstPunchMs = Number.POSITIVE_INFINITY;

  for (const punch of punches) {
    const employee = employeeByDeviceId.get(normalizeBiometricId(punch.deviceUserId));
    if (!employee) {
      unmatchedIds.add(String(punch.deviceUserId).trim());
      continue;
    }
    const dateIso = iso(punch.punchedAt);
    const key = `${employee.id}|${dateIso}`;
    const group = groups.get(key) ?? { employeeId: employee.id, dateIso, times: [] };
    group.times.push(
      punch.punchedAt.getUTCHours() * 60 + punch.punchedAt.getUTCMinutes(),
    );
    groups.set(key, group);
    firstPunchMs = Math.min(firstPunchMs, Date.parse(`${dateIso}T00:00:00.000Z`));
  }

  // Days to fill: from the start of the range up to the last day that is over.
  // Recent mode always covers its whole window (so a day without any punch still closes);
  // full mode starts at the first punch in the log.
  const rangeStartMs = since ? since.getTime() : firstPunchMs;
  const lastClosedMs = nowMinutes >= cfg.shiftEnd ? todayMs : todayMs - DAY_MS;
  if (!Number.isFinite(rangeStartMs)) {
    return emptySummary(punches.length, unmatchedIds);
  }
  const rangeStart = new Date(rangeStartMs);
  const rangeEnd = new Date(todayMs);

  // Calendar (weekly off days and holidays) for each month in the range
  const calendars = new Map<string, { off: number[]; holidays: Set<string> }>();
  const dayTypeOf = async (date: Date): Promise<DayType> => {
    const key = iso(date).slice(0, 7);
    let calendar = calendars.get(key);
    if (!calendar) {
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + 1;
      const [override, holidays] = await Promise.all([
        prisma.monthlyOffDays.findUnique({ where: { year_month: { year, month } } }),
        prisma.holiday.findMany({
          where: {
            date: {
              gte: new Date(Date.UTC(year, month - 1, 1)),
              lt: new Date(Date.UTC(year, month, 1)),
            },
          },
          select: { date: true },
        }),
      ]);
      calendar = {
        off: override?.weeklyOffDays ?? settings.defaultWeeklyOffDays,
        holidays: new Set(holidays.map((h) => iso(h.date))),
      };
      calendars.set(key, calendar);
    }
    if (calendar.holidays.has(iso(date))) return "HOLIDAY";
    return calendar.off.includes(date.getUTCDay()) ? "WEEKEND" : "WORKING";
  };

  const [existing, leaves] = await Promise.all([
    prisma.attendance.findMany({
      where: { date: { gte: rangeStart, lte: rangeEnd } },
      select: {
        employeeId: true,
        date: true,
        isManual: true,
        checkIn: true,
        checkOut: true,
        workingMinutes: true,
        lateMinutes: true,
        earlyLeaveMinutes: true,
        overtimeMinutes: true,
        status: true,
        remarks: true,
        punches: true,
      },
    }),
    prisma.leaveRequest.findMany({
      where: {
        status: "APPROVED",
        startDate: { lte: rangeEnd },
        endDate: { gte: rangeStart },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
  ]);
  const existingByKey = new Map<string, (typeof existing)[number]>(
    existing.map((r) => [`${r.employeeId}|${iso(r.date)}`, r]),
  );
  const existingKeys = new Set(existingByKey.keys());
  const manualKeys = new Set(
    existing.filter((r) => r.isManual).map((r) => `${r.employeeId}|${iso(r.date)}`),
  );
  const onLeave = (employeeId: string, date: Date) =>
    leaves.some(
      (l) => l.employeeId === employeeId && l.startDate <= date && l.endDate >= date,
    );
  const joinedBy = new Map(employees.map((e) => [e.id, e.joiningDate]));

  let processed = 0;
  let skippedManual = 0;
  let skippedBeforeJoining = 0;

  // ---- 1. employee-days that have punches
  const toCreate: (AttendanceFields & { employeeId: string; date: Date })[] = [];
  const toUpdate: AttendanceWrite[] = [];
  for (const group of groups.values()) {
    const date = new Date(`${group.dateIso}T00:00:00.000Z`);
    const joining = joinedBy.get(group.employeeId);
    if (joining && group.dateIso < iso(joining)) {
      skippedBeforeJoining++;
      continue;
    }
    if (manualKeys.has(`${group.employeeId}|${group.dateIso}`)) {
      skippedManual++;
      continue;
    }

    const { result, note } = evaluateLiveDay(
      {
        dayType: await dayTypeOf(date),
        punches: group.times,
        isToday: group.dateIso === todayIso,
        nowMinutes,
      },
      cfg,
    );

    let status = result.status as AttendanceStatus;
    let remarks = [result.remarks, note].filter(Boolean).join("; ");
    if (
      (status === "ABSENT" || status === "INCOMPLETE") &&
      onLeave(group.employeeId, date)
    ) {
      status = "ON_LEAVE";
      remarks = "Approved leave";
    }

    const fields: AttendanceFields = {
      checkIn: result.checkIn === null ? null : new Date(date.getTime() + result.checkIn * 60_000),
      checkOut: result.checkOut === null ? null : new Date(date.getTime() + result.checkOut * 60_000),
      workingMinutes: result.workingMinutes,
      lateMinutes: result.lateMinutes,
      earlyLeaveMinutes: result.earlyLeaveMinutes,
      overtimeMinutes: result.overtimeMinutes,
      status,
      remarks: remarks ? `${remarks}; ${SOURCE}` : SOURCE,
      punches: result.accepted.map(formatMinutes).join(" ") || null,
      sourceBatchId: null,
    };

    const stored = existingByKey.get(`${group.employeeId}|${group.dateIso}`);
    if (!stored) {
      toCreate.push({ employeeId: group.employeeId, date, ...fields });
    } else if (differsFromStored(stored, fields)) {
      toUpdate.push({ employeeId: group.employeeId, date, data: fields });
    }
    processed++;
  }

  // Progress lines: one slow round on a cold Neon database is hard to tell apart from a
  // wedged one without them.
  console.log(
    `uFace800 attendance: ${punches.length} punches, ${groups.size} employee-days, ` +
      `${toCreate.length} new rows, ${toUpdate.length} changed rows`,
  );

  // New employee-days go in with a few bulk INSERTs. This is the first-run path:
  // tens of thousands of rows would take far too long one interactive transaction at a time.
  for (let i = 0; i < toCreate.length; i += 500) {
    await prisma.attendance.createMany({
      data: toCreate.slice(i, i + 500),
      skipDuplicates: true,
    });
    console.log(
      `uFace800 attendance: inserted ${Math.min(i + 500, toCreate.length)}/${toCreate.length}`,
    );
  }

  // Only rows whose computed values changed are rewritten, so a normal poll touches a
  // handful of rows (mostly today's) instead of the whole history.
  for (let i = 0; i < toUpdate.length; i += 100) {
    await prisma.$transaction(
      toUpdate.slice(i, i + 100).map((row) =>
        prisma.attendance.update({
          where: {
            employeeId_date: {
              employeeId: row.employeeId,
              date: row.date,
            },
          },
          data: row.data,
        }),
      ),
      // Neon round-trips are slow; the 5 s default is too tight for a batch of writes.
      { maxWait: 15_000, timeout: 60_000 },
    );
    console.log(
      `uFace800 attendance: updated ${Math.min(i + 100, toUpdate.length)}/${toUpdate.length}`,
    );
  }

  // ---- 2. days that are over, with no row yet: absent / on leave / weekly off / holiday
  let filled = 0;
  const activeEmployees = employees.filter((e) => e.isActive);
  const fillRows = [];
  for (let ms = rangeStartMs; ms <= lastClosedMs; ms += DAY_MS) {
    const date = new Date(ms);
    const dateIso = iso(date);
    const dayType = await dayTypeOf(date);
    for (const employee of activeEmployees) {
      const key = `${employee.id}|${dateIso}`;
      if (existingKeys.has(key) || groups.has(key)) continue;
      if (employee.joiningDate && dateIso < iso(employee.joiningDate)) continue;

      const result = evaluateDay({ dayType, punches: [] }, cfg);
      let status = result.status as AttendanceStatus;
      let remarks = result.remarks;
      if (status === "ABSENT" && onLeave(employee.id, date)) {
        status = "ON_LEAVE";
        remarks = "Approved leave";
      }
      fillRows.push({
        employeeId: employee.id,
        date,
        status,
        remarks: remarks ? `${remarks}; ${SOURCE}` : SOURCE,
        sourceBatchId: null,
      });
    }
  }
  for (let i = 0; i < fillRows.length; i += 500) {
    const result = await prisma.attendance.createMany({
      data: fillRows.slice(i, i + 500),
      skipDuplicates: true, // never replaces a row that already exists
    });
    filled += result.count;
  }

  // ---- 3. approved leave: also turns Absent / Missing punch rows into "On leave" and starts a
  //         leave that was approved in advance once its first day arrives
  const leaveSync = await syncApprovedLeavesToAttendance(options.sinceDays ?? 2);

  const summary = {
    rawPunches: punches.length,
    matchedEmployeeDays: groups.size,
    processed,
    filledDaysWithoutPunches: filled,
    skippedManual,
    skippedBeforeJoining,
    leaveRowsWritten: leaveSync.rowsWritten,
    unmatchedDeviceUserIds: [...unmatchedIds].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
  };
  console.log("uFace800 attendance processing summary:", summary);
  if (summary.unmatchedDeviceUserIds.length) {
    console.warn(
      "These device IDs have no Employee.biometricId match. Add the exact IDs in the employee records:",
      summary.unmatchedDeviceUserIds.join(", "),
    );
  }
  return summary;
}

function emptySummary(rawPunches: number, unmatched: Set<string>) {
  const summary = {
    rawPunches,
    matchedEmployeeDays: 0,
    processed: 0,
    filledDaysWithoutPunches: 0,
    skippedManual: 0,
    skippedBeforeJoining: 0,
    unmatchedDeviceUserIds: [...unmatched],
  };
  console.log("uFace800 attendance processing summary:", summary);
  return summary;
}
