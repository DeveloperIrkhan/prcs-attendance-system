import { prisma } from "@/lib/prisma";
import { ServiceError } from "@/lib/action-state";
import type { ApprovalLevel } from "@/lib/leave/approval-routing";
import { recordAudit } from "./audit.service";

export function listDesignations() {
  return prisma.designation.findMany({
    orderBy: { title: "asc" },
    include: { _count: { select: { employees: true } } },
  });
}

export async function createDesignation(input: {
  title: string;
  approvalLevel: ApprovalLevel;
}) {
  const exists = await prisma.designation.findFirst({
    where: { title: { equals: input.title, mode: "insensitive" } },
    select: { id: true },
  });
  if (exists) throw new ServiceError("This designation already exists.");

  const created = await prisma.designation.create({
    data: { title: input.title, approvalLevel: input.approvalLevel },
  });
  await recordAudit({
    action: "designation.create",
    entity: "Designation",
    entityId: created.id,
    summary: `Created the designation ${created.title} (${created.approvalLevel})`,
    after: { title: created.title, approvalLevel: created.approvalLevel },
  });
  return created;
}

export async function updateDesignation(
  id: string,
  input: { title: string; approvalLevel: ApprovalLevel },
) {
  const exists = await prisma.designation.findFirst({
    where: { title: { equals: input.title, mode: "insensitive" }, NOT: { id } },
    select: { id: true },
  });
  if (exists) throw new ServiceError("This designation already exists.");

  const before = await prisma.designation.findUnique({
    where: { id },
    select: { title: true, approvalLevel: true },
  });
  const updated = await prisma.designation.update({
    where: { id },
    data: { title: input.title, approvalLevel: input.approvalLevel },
  });
  await recordAudit({
    action: "designation.update",
    entity: "Designation",
    entityId: id,
    summary: `Updated the designation ${updated.title} (${updated.approvalLevel})`,
    before,
    after: { title: updated.title, approvalLevel: updated.approvalLevel },
  });
  return updated;
}

export async function deleteDesignation(id: string) {
  const designation = await prisma.designation.findUnique({
    where: { id },
    select: { title: true, approvalLevel: true },
  });
  const count = await prisma.employee.count({ where: { designationId: id } });
  if (count > 0) {
    throw new ServiceError(
      `Cannot delete: ${count} employee(s) have this designation.`,
    );
  }
  await prisma.designation.delete({ where: { id } });
  await recordAudit({
    action: "designation.delete",
    entity: "Designation",
    entityId: id,
    summary: `Deleted the designation ${designation?.title ?? id}`,
    before: designation,
  });
}
