import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/lib/action-state";
import { recordAudit } from "./audit.service";

type DepartmentInput = { name: string; description?: string };

export function listDepartments() {
  return prisma.department.findMany({
    orderBy: { name: "asc" }, //assending order
    include: { _count: { select: { employees: true } } },
  });
}

//insensitive :
//means compare department names without treating uppercase and lowercase letters as different.
export async function createDepartment(input: DepartmentInput) {
  const exists = await prisma.department.findFirst({
    where: { name: { equals: input.name, mode: "insensitive" } },
    select: { id: true },
  });
  if (exists)
    throw new ServiceError("A department with this name already exists.");

  const created = await prisma.department.create({
    data: { name: input.name, description: input.description ?? null },
  });
  await recordAudit({
    action: "department.create",
    entity: "Department",
    entityId: created.id,
    summary: `Created the department ${created.name}`,
    after: { name: created.name, description: created.description },
  });
  return created;
}

export async function updateDepartment(id: string, input: DepartmentInput) {
  const exists = await prisma.department.findFirst({
    where: {
      name: { equals: input.name, mode: "insensitive" },
      NOT: { id: id },
    },
    select: { id: true },
  });
  if (exists)
    throw new ServiceError("A department with this name already exists.");

  const before = await prisma.department.findUnique({
    where: { id },
    select: { name: true, description: true },
  });
  const updated = await prisma.department.update({
    where: { id },
    data: { name: input.name, description: input.description ?? null },
  });
  await recordAudit({
    action: "department.update",
    entity: "Department",
    entityId: id,
    summary: `Updated the department ${updated.name}`,
    before,
    after: { name: updated.name, description: updated.description },
  });
  return updated;
}

export async function deleteDepartment(id: string) {
  const department = await prisma.department.findUnique({
    where: { id },
    select: { name: true },
  });
  const count = await prisma.employee.count({ where: { departmentId: id } });
  if (count > 0) {
    throw new ServiceError(
      `Cannot delete: ${count} employee(s) belong to this department.`,
    );
  }
  await prisma.department.delete({ where: { id } });
  await recordAudit({
    action: "department.delete",
    entity: "Department",
    entityId: id,
    summary: `Deleted the department ${department?.name ?? id}`,
    before: department,
  });
}

/** Departments with the heads who look after them: their DD / HOD, and additional-charge DDs. */
export function listDepartmentsWithApprovers() {
  return prisma.department.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { employees: true } },
      employees: {
        where: {
          isActive: true,
          designation: { approvalLevel: { in: ["DD", "HOD"] } },
        },
        select: {
          id: true,
          name: true,
          designation: { select: { approvalLevel: true } },
        },
        orderBy: { name: "asc" },
      },
      chargeHolders: {
        select: {
          id: true,
          employee: {
            select: {
              id: true,
              name: true,
              isActive: true,
              department: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

/** Active employees whose designation is at DD level: the only ones who can hold additional charge. */
export function listDdEmployees() {
  return prisma.employee.findMany({
    where: { isActive: true, designation: { approvalLevel: "DD" } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      employeeCode: true,
      departmentId: true,
      department: { select: { name: true } },
    },
  });
}

export async function addDepartmentCharge(
  departmentId: string,
  employeeId: string,
) {
  const [department, employee] = await Promise.all([
    prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true, name: true },
    }),
    prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        name: true,
        isActive: true,
        departmentId: true,
        designation: { select: { approvalLevel: true } },
      },
    }),
  ]);
  if (!department) throw new ServiceError("Department not found.");
  if (!employee || !employee.isActive)
    throw new ServiceError("Employee not found or inactive.");
  if (employee.designation?.approvalLevel !== "DD") {
    throw new ServiceError(
      `${employee.name} is not a DD. Only an employee whose designation has approval level DD can hold additional charge.`,
    );
  }
  if (employee.departmentId === departmentId) {
    throw new ServiceError(
      `${employee.name} already belongs to ${department.name}.`,
    );
  }
  const exists = await prisma.departmentCharge.findUnique({
    where: { employeeId_departmentId: { employeeId, departmentId } },
    select: { id: true },
  });
  if (exists) {
    throw new ServiceError(
      `${employee.name} already has additional charge of ${department.name}.`,
    );
  }
  const created = await prisma.departmentCharge.create({
    data: { employeeId, departmentId },
  });
  await recordAudit({
    action: "department.charge-add",
    entity: "Department",
    entityId: departmentId,
    summary: `Gave ${employee.name} additional charge of ${department.name}`,
    after: { employeeId, departmentId },
  });
  return created;
}

export async function removeDepartmentCharge(id: string) {
  const found = await prisma.departmentCharge.findUnique({
    where: { id },
    select: {
      id: true,
      departmentId: true,
      department: { select: { name: true } },
      employee: { select: { name: true } },
    },
  });
  if (!found) throw new ServiceError("This additional charge no longer exists.");
  await prisma.departmentCharge.delete({ where: { id } });
  await recordAudit({
    action: "department.charge-remove",
    entity: "Department",
    entityId: found.departmentId,
    summary: `Removed ${found.employee.name}'s additional charge of ${found.department.name}`,
    before: { employee: found.employee.name, department: found.department.name },
  });
}

// ---- Acting CEO / Chairman (while the post is vacant) ----

export type ActingLevel = "CEO" | "CHAIRMAN";
const ACTING_RANK = { STAFF: 0, HOD: 1, DD: 2, CEO: 3, CHAIRMAN: 4 } as const;

export function listActingApprovers() {
  return prisma.actingApprover.findMany({
    orderBy: [{ level: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      level: true,
      employee: {
        select: {
          name: true,
          isActive: true,
          department: { select: { name: true } },
          designation: { select: { title: true } },
          user: { select: { isActive: true } },
        },
      },
    },
  });
}

/** Active employees at DD level or above: the ones who can step in for a vacant CEO or Chairman. */
export function listActingCandidates() {
  return prisma.employee.findMany({
    where: {
      isActive: true,
      designation: { approvalLevel: { in: ["DD", "CEO"] } },
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      department: { select: { name: true } },
      designation: { select: { title: true, approvalLevel: true } },
    },
  });
}

export async function addActingApprover(employeeId: string, level: ActingLevel) {
  if (level !== "CEO" && level !== "CHAIRMAN") {
    throw new ServiceError("Choose Secretary General or Chairperson.");
  }
  const levelLabel = level === "CEO" ? "Secretary General" : "Chairperson";
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      name: true,
      isActive: true,
      designation: { select: { approvalLevel: true } },
      user: { select: { isActive: true } },
    },
  });
  if (!employee || !employee.isActive) {
    throw new ServiceError("Employee not found or inactive.");
  }
  if (!employee.user?.isActive) {
    throw new ServiceError(
      `${employee.name} has no active login, so they could not approve anything. Create or activate their login first.`,
    );
  }
  const own = employee.designation?.approvalLevel ?? "STAFF";
  if (ACTING_RANK[own] < ACTING_RANK.DD) {
    throw new ServiceError(
      `${employee.name} is not at DD level. Only a DD or higher can act as ${levelLabel}.`,
    );
  }
  if (ACTING_RANK[own] >= ACTING_RANK[level]) {
    throw new ServiceError(
      `${employee.name} already holds ${own === level ? "that" : "a higher"} level by designation.`,
    );
  }
  const exists = await prisma.actingApprover.findUnique({
    where: { employeeId_level: { employeeId, level } },
    select: { id: true },
  });
  if (exists) {
    throw new ServiceError(`${employee.name} is already acting as ${levelLabel}.`);
  }
  const created = await prisma.actingApprover.create({
    data: { employeeId, level },
  });
  await recordAudit({
    action: "department.acting-add",
    entity: "ActingApprover",
    entityId: created.id,
    summary: `Made ${employee.name} acting ${levelLabel}`,
    after: { employee: employee.name, level },
  });
  return created;
}

export async function removeActingApprover(id: string) {
  const found = await prisma.actingApprover.findUnique({
    where: { id },
    select: {
      id: true,
      level: true,
      employee: { select: { name: true } },
    },
  });
  if (!found) throw new ServiceError("This acting role no longer exists.");
  await prisma.actingApprover.delete({ where: { id } });
  await recordAudit({
    action: "department.acting-remove",
    entity: "ActingApprover",
    entityId: id,
    summary: `Removed ${found.employee.name} as acting ${
      found.level === "CEO" ? "Secretary General" : "Chairperson"
    }`,
    before: { employee: found.employee.name, level: found.level },
  });
}
