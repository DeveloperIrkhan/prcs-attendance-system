import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Who leads a department for approval purposes.
 *
 * A department is led by its DD (own designation or additional charge). When it has no DD,
 * it is led by its HOD, or by an AD who has been given additional charge of that department
 * ("acting HOD"). Only active employees with an active login count.
 */

const ACTING_HOD_TITLE = "AD";

export type DepartmentHead = {
  employeeId: string;
  level: "DD" | "HOD";
  /** true when this person leads the department through additional charge */
  viaCharge: boolean;
};

const headSelect = {
  id: true,
  departmentId: true,
  designation: { select: { approvalLevel: true, title: true } },
} as const;

/** An active DD in this department, or a DD holding additional charge of it. */
export async function findDepartmentDd(
  requesterId: string,
  departmentId: string,
): Promise<DepartmentHead | null> {
  const dd = await prisma.employee.findFirst({
    where: {
      id: { not: requesterId },
      isActive: true,
      user: { is: { isActive: true } },
      designation: { approvalLevel: "DD" },
      OR: [
        { departmentId },
        { additionalCharges: { some: { departmentId } } },
      ],
    },
    select: headSelect,
  });
  return dd
    ? {
        employeeId: dd.id,
        level: "DD",
        viaCharge: dd.departmentId !== departmentId,
      }
    : null;
}

/**
 * An active HOD of this department, or an AD / HOD holding additional charge of it.
 * The latter is the "acting HOD" for departments that have no DD.
 */
export async function findDepartmentHod(
  requesterId: string,
  departmentId: string,
): Promise<DepartmentHead | null> {
  const hod = await prisma.employee.findFirst({
    where: {
      id: { not: requesterId },
      isActive: true,
      user: { is: { isActive: true } },
      OR: [
        { departmentId, designation: { approvalLevel: "HOD" } },
        {
          additionalCharges: { some: { departmentId } },
          designation: {
            OR: [
              { approvalLevel: "HOD" },
              { title: { equals: ACTING_HOD_TITLE, mode: "insensitive" } },
            ],
          },
        },
      ],
    },
    select: headSelect,
  });
  return hod
    ? {
        employeeId: hod.id,
        level: "HOD",
        // An AD acting as HOD is always via the charge record, even when the AD
        // belongs to the department they now head.
        viaCharge:
          hod.designation?.approvalLevel !== "HOD" ||
          hod.departmentId !== departmentId,
      }
    : null;
}

/** DD first; HOD / acting HOD only when there is no usable DD. */
export async function findDepartmentHead(
  requesterId: string,
  departmentId: string,
): Promise<DepartmentHead | null> {
  return (
    (await findDepartmentDd(requesterId, departmentId)) ??
    (await findDepartmentHod(requesterId, departmentId))
  );
}
